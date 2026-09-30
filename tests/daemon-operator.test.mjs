import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { OperatorService } from "../dist/daemon/service.js";
import { serve } from "../dist/daemon/server.js";
import { defaults } from "../dist/daemon/config.js";
import { execute, GitHub } from "../dist/delivery/github.js";
import { OpencodeAdapter } from "../dist/agents/opencode/index.js";
import { delay } from "../dist/runner/process.js";
import { identify } from "../dist/runner/process.js";
import { ATT764_TASK } from "../dist/attraccess/current.js";
import {
  opencodeFixture,
  finalProposal,
  successScript,
  defaultExportMarker,
} from "./opencode-support.mjs";

function fixture(name, options = {}) {
  const f = opencodeFixture("operator-" + name);
  f.store.close();
  const home = join(f.dir, "daemon");
  mkdirSync(home);
  const repo = join(f.dir, "target");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  // Owned fixtures must not invoke the user's signing agent. Retain actual signed
  // commits using a disposable key, including in the operator's cloned workspace.
  const signingKey = join(f.dir, "fixture-signing-key"),
    allowedSigners = join(f.dir, "allowed-signers");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", signingKey], {
    stdio: "pipe",
  });
  const publicKey = readFileSync(signingKey + ".pub", "utf8").trim();
  writeFileSync(
    allowedSigners,
    `fixture@localhost ${publicKey}\nrocky@localhost ${publicKey}\n`,
  );
  const signing = {
    "gpg.format": "ssh",
    "gpg.ssh.program": "/usr/bin/ssh-keygen",
    "user.signingkey": signingKey,
    "gpg.ssh.allowedSignersFile": allowedSigners,
    "commit.gpgsign": "true",
  };
  for (const [key, value] of Object.entries(signing)) git("config", key, value);
  git("remote", "add", "origin", "https://github.com/synthetic/target.git");
  writeFileSync(join(repo, "index.mjs"), 'export const label = "before";\n');
  writeFileSync(
    join(repo, "check.mjs"),
    'import assert from "node:assert/strict";import {label} from "./index.mjs";assert.equal(typeof label,"string");assert.ok(label.length);\n',
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "fixture",
  );
  let agentPlan = null,
    pr = null,
    attempt = 1,
    merges = 0,
    drafts = 0,
    ready = 0;
  const github = {
    async attempts(repository, p) {
      return {
        head: p.head,
        integration: p.integration,
        identities: [
          {
            source: "check-run",
            id: attempt,
            sha: p.integration,
            name: "fixture-check",
            workflowRun: 10,
            workflowAttempt: attempt,
          },
        ],
      };
    },
    async draft(repository, branch, base, head) {
      drafts++;
      pr = {
        number: 1,
        url: "https://github.com/synthetic/target/pull/1",
        head,
        base: git("rev-parse", "HEAD"),
        integration: "e".repeat(40),
        state: "open",
        draft: true,
        merged: false,
        mergeCommit: null,
      };
      return structuredClone(pr);
    },
    async pull() {
      return structuredClone(pr);
    },
    async observe(repository, p) {
      return {
        attempts: await github.attempts(repository, p),
        head: p.head,
        integration: p.integration,
        outcome: "pass",
        checks: [
          {
            id: attempt,
            source: "check-run",
            workflowRun: 10,
            workflowAttempt: attempt,
            name: "fixture-check",
            sha: p.integration,
            status: "completed",
            conclusion: "success",
            url: "",
          },
        ],
        observedAt: Date.now(),
      };
    },
    async ready() {
      ready++;
      pr.draft = false;
      return structuredClone(pr);
    },
    async merge() {
      merges++;
      pr.merged = true;
      pr.mergeCommit = "f".repeat(40);
      pr.state = "closed";
      return structuredClone(pr);
    },
  };
  const authority = {
    repository: "synthetic/target",
    liveApproval: "SYNTHETIC ONLY",
    nativeProbeEvidence: "owned fake CLI",
    authBoundaryApproval: "no credential",
    qualification: f.config.qualification,
    checks: [
      { name: "fixture-check", file: process.execPath, args: ["check.mjs"] },
    ],
    requiredCI: ["fixture-check"],
  };
  const deps = {
    authority,
    runtime: f.config,
    github,
    async execute(file, args, cwd) {
      const out = await execute(file, args, cwd);
      if (file === "git" && args[0] === "clone")
        for (const [key, value] of Object.entries(signing))
          execFileSync("git", ["config", key, value], {
            cwd: args.at(-1),
            stdio: "pipe",
          });
      if (file === "git" && args.includes("commit"))
        execFileSync("git", ["verify-commit", "HEAD"], { cwd, stdio: "pipe" });
      return out;
    },
    adapter(store, lease, config) {
      const adapter = new OpencodeAdapter(store, lease, config, {
        sourceEnv: f.sourceEnv,
      });
      const original = adapter.prepareLaunch.bind(adapter);
      adapter.prepareLaunch = (action, input) => {
        const role = action.kind === "review" ? "reviewer" : "implementer";
        const proposal = finalProposal(
          action,
          role,
          role === "reviewer" ? "complete" : "changed",
        );
        const script = successScript(
          proposal,
          role === "implementer"
            ? {
                writeSrc: {
                  path: "index.mjs",
                  content: 'export const label = "after";\n',
                },
              }
            : {},
        );
        if (role === "reviewer")
          script.script = script.script.filter((x) => !x.toolUse);
        if (options.agentScript)
          script.script = options.agentScript(script.script, action);
        const plan = original(action, {
          ...input,
          prompt: JSON.stringify(script),
        });
        agentPlan = plan;
        writeFileSync(
          join(plan.paths.parentTmp, "fake-export.json"),
          JSON.stringify(defaultExportMarker(plan)),
        );
        return plan;
      };
      return adapter;
    },
  };
  const service = new OperatorService(home, deps);
  service.configure({
    ...defaults,
    repositoryPath: repo,
    repository: "synthetic/target",
    task: "Change label to after",
    actionMinutes: 1,
    totalMinutes: 10,
  });
  return {
    service,
    home,
    deps,
    get agentPlan() {
      return agentPlan;
    },
    get pr() {
      return pr;
    },
    set pr(v) {
      pr = v;
    },
    counts: () => ({ drafts, merges, ready }),
    set attempt(value) {
      attempt = value;
    },
    repo,
  };
}

test("HTTP config persistence, truthful preflight blocker, local origin gate and SSE", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-http-"));
  const service = new OperatorService(home);
  const app = await serve(service, 0);
  try {
    const request = (path, method = "GET", body) =>
      fetch(app.url + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const changed = { ...defaults, task: "A scoped UI task" };
    const profile = await (await request("/api/preflight")).json();
    assert.equal(profile.model, null);
    assert.deepEqual(profile.roles, []);
    assert.equal((await request("/api/config", "PUT", changed)).status, 200);
    assert.deepEqual(await (await request("/api/config")).json(), changed);
    const blocked = await (await request("/api/runs", "POST", {})).json();
    assert.equal(blocked.phase, "blocked");
    assert.equal(blocked.snapshot, null);
    assert.match(blocked.message, /rocky-next setup/);
    const hostile = await fetch(app.url + "/api/runs", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(hostile.status, 400);
    const stream = await fetch(app.url + "/api/events");
    const reader = stream.body.getReader();
    const frame = await reader.read();
    assert.match(new TextDecoder().decode(frame.value), /event: change/);
    await reader.cancel();
    const html = await (await request("/")).text();
    assert.match(html, /From task to reviewed change/);
  } finally {
    await app.close();
  }
  const restarted = new OperatorService(home);
  assert.equal(restarted.config().task, "A scoped UI task");
  assert.equal(restarted.runs().length, 1);
  await restarted.close();
});

function barrier() {
  let entered, release;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  return {
    waiting,
    release,
    async wait() {
      entered();
      await pending;
    },
  };
}
async function published(f) {
  const run = await f.service.start();
  await f.service.idle();
  assert.equal(
    f.service.run(run.id).phase,
    "awaiting_ci",
    f.service.run(run.id).message,
  );
  return run.id;
}
async function reviewed(f) {
  const id = await published(f);
  await f.service.refresh(id);
  await f.service.idle();
  assert.equal(
    f.service.run(id).phase,
    "awaiting_approval",
    f.service.run(id).message,
  );
  return id;
}

function assertCancelledSettlement(service, id, actionKey, result) {
  const snapshot = service.store.coordinatorSnapshot(id);
  assert.equal(snapshot.cancelled, true);
  assert.equal(snapshot.stage, "cancelled");
  assert.equal(snapshot.execution, null);
  assert.equal(service.store.implementationSlot(), null);
  assert.ok(service.store.commands(id).every((c) => c.state === "finished"));
  const effect = service.store.effect(actionKey);
  assert.equal(effect.state, "confirmed");
  assert.equal(effect.receipt.actionKey, actionKey);
  assert.equal(effect.receipt.quiescent, true);
  if (result) assert.deepEqual(effect.receipt, result);
  assert.equal(service.detail(id).rerunReady, true);
}

test("repair117: successful queue request is acknowledged then reconciled read-only before stale base/CI handling", async () => {
  const f = fixture("queue117");
  let sends = 0,
    reads = 0;
  const originalPull = f.deps.github.pull.bind(f.deps.github);
  f.deps.github.pull = async (...args) => {
    reads++;
    return originalPull(...args);
  };
  const gh = new GitHub(async (file, args) => {
    if (args[0] === "pr" && args[1] === "merge") {
      sends++;
      return "queued";
    }
    assert.equal(args[0], "api");
    reads++;
    return JSON.stringify({
      number: f.pr.number,
      html_url: f.pr.url,
      head: { sha: f.pr.head },
      base: { sha: f.pr.base },
      merge_commit_sha: f.pr.merged ? f.pr.mergeCommit : f.pr.integration,
      state: f.pr.state,
      draft: f.pr.draft,
      merged: f.pr.merged,
    });
  });
  f.deps.github.merge = gh.merge.bind(gh);
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    await f.service.approve(id, head);
    await f.service.merge(id, head);
    await f.service.idle();
    assert.equal(
      f.service.run(id).phase,
      "merge_requested",
      f.service.run(id).message,
    );
    assert.equal(
      f.service.store.effect(`operator/${id}/merge/${head}`).state,
      "confirmed",
    );
    assert.equal(f.service.run(id).mergeRequest.head, head);
    await assert.rejects(
      f.service.merge(id, head),
      /requested|reconciliation|busy/,
    );
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "merge_requested");
    f.pr = {
      ...f.pr,
      merged: true,
      state: "closed",
      mergeCommit: "f".repeat(40),
      base: "d".repeat(40),
      integration: "f".repeat(40),
    };
    f.deps.github.observe = async () => {
      throw new Error("CI must not be recollected after requested merge");
    };
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "merged", f.service.run(id).message);
    assert.equal(f.service.run(id).closedAt, null);
    assert.equal(
      f.service.closeout(id, "Separate manual closeout").phase,
      "closed",
    );
    assert.equal(sends, 1);
    assert.ok(
      reads >= 3,
      "later reconciliation uses read-only PR observations",
    );
  } finally {
    await f.service.close();
  }
});

test("repair117: late draft and CI completions preserve cancellation and sent-effect receipts", async (t) => {
  for (const operation of ["draft", "observe"])
    await t.test(operation, async () => {
      const f = fixture("cancel117-" + operation),
        gate = barrier();
      const original = f.deps.github[operation].bind(f.deps.github);
      f.deps.github[operation] = async (...args) => {
        await gate.wait();
        return original(...args);
      };
      try {
        const id =
          operation === "draft"
            ? (await f.service.start()).id
            : await published(f);
        if (operation === "observe") await f.service.refresh(id);
        await gate.waiting;
        await f.service.cancel(id);
        gate.release();
        await f.service.idle();
        const d = f.service.detail(id);
        assert.equal(d.phase, "cancelled", d.message);
        assert.equal(d.snapshot.cancelled, true);
        assert.equal(d.snapshot.receipts.approval, undefined);
        if (operation === "draft")
          assert.equal(
            f.service.store.effect(`operator/${id}/draft/${d.head}`).state,
            "confirmed",
          );
        assert.equal(f.counts().merges, 0);
      } finally {
        gate.release();
        await f.service.close();
      }
    });
});

test("repair117: cancellation after already-sent merge preserves cancellation and confirmed external receipt", async () => {
  const f = fixture("cancel-merge117"),
    gate = barrier(),
    original = f.deps.github.merge.bind(f.deps.github);
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    await f.service.approve(id, head);
    f.deps.github.merge = async (...args) => {
      await gate.wait();
      return original(...args);
    };
    await f.service.merge(id, head);
    await gate.waiting;
    await f.service.cancel(id);
    gate.release();
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "cancelled");
    assert.equal(
      f.service.store.effect(`operator/${id}/merge/${head}`).state,
      "confirmed",
    );
    assert.equal(f.counts().merges, 1);
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "cancelled");
    assert.equal(f.counts().merges, 1);
  } finally {
    gate.release();
    await f.service.close();
  }
});

test("repair117: stale saved operator projection cannot erase durable cancellation", async () => {
  const f = fixture("cancel-save117");
  try {
    const id = await published(f),
      stale = f.service.run(id);
    await f.service.cancel(id);
    stale.phase = "awaiting_approval";
    assert.throws(() => f.service.save(stale), /cancelled|revision|stale/);
    assert.equal(f.service.run(id).phase, "cancelled");
  } finally {
    await f.service.close();
  }
});

test("repair117: one stable issue forbids a second CI/approval run and requires explicit safe predecessor rerun", async () => {
  const f = fixture("issue117");
  try {
    const id = await published(f);
    await assert.rejects(f.service.start(), /issue|workflow|rerun/);
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "awaiting_approval");
    await assert.rejects(f.service.start(), /issue|workflow|rerun/);
    await f.service.cancel(id);
    await assert.rejects(f.service.start(), /explicit|predecessor|rerun/);
    assert.equal(f.service.detail(id).rerunReady, true);
    const next = await f.service.start({ previousRunId: id });
    await f.service.idle();
    const old = f.service.store.coordinatorSnapshot(id),
      current = f.service.store.coordinatorSnapshot(next.id);
    assert.equal(current.issue, old.issue);
    assert.notEqual(current.issue, current.runId);
    assert.notEqual(current.rerun, old.rerun);
  } finally {
    await f.service.close();
  }
});

test("repair117: cancelled acknowledged queue remains an unresolved predecessor until read-only confirmed merge", async () => {
  const f = fixture("queue-rerun117");
  let sends = 0;
  f.deps.github.merge = async (_repository, pr, head) => {
    sends++;
    return { number: pr.number, head, requestedAt: Date.now() };
  };
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    await f.service.approve(id, head);
    await f.service.merge(id, head);
    await f.service.idle();
    await f.service.cancel(id);
    assert.equal(f.service.detail(id).rerunReady, false);
    await assert.rejects(
      f.service.start({ previousRunId: id }),
      /effect|reconciliation/,
    );
    f.pr = {
      ...f.pr,
      merged: true,
      state: "closed",
      mergeCommit: "f".repeat(40),
    };
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "cancelled");
    assert.equal(f.service.run(id).pr.merged, true);
    assert.equal(sends, 1);
    const rerun = await f.service.start({ previousRunId: id });
    await f.service.idle();
    assert.equal(
      f.service.store.coordinatorSnapshot(rerun.id).issue,
      f.service.store.coordinatorSnapshot(id).issue,
    );
  } finally {
    await f.service.close();
  }
});

test("repair117: CI changing during awaited ready prevents the separate merge write", async () => {
  const f = fixture("ready-ci117"),
    gate = barrier(),
    original = f.deps.github.ready.bind(f.deps.github);
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    await f.service.approve(id, head);
    f.deps.github.ready = async (...args) => {
      await gate.wait();
      return original(...args);
    };
    await f.service.merge(id, head);
    await gate.waiting;
    f.attempt = 2;
    gate.release();
    await f.service.idle();
    assert.equal(f.counts().ready, 1);
    assert.equal(f.counts().merges, 0);
    assert.equal(f.service.run(id).approval, null);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.approval,
      undefined,
    );
  } finally {
    gate.release();
    await f.service.close();
  }
});

test("repair117: unresolved sent effect prevents even explicit predecessor rerun", async () => {
  const f = fixture("unresolved-issue117");
  f.deps.github.draft = async () => {
    throw new Error("Ambiguous remote request");
  };
  try {
    const run = await f.service.start();
    await f.service.idle();
    await f.service.cancel(run.id);
    await assert.rejects(
      f.service.start({ previousRunId: run.id }),
      /effect|reconciliation|unresolved/,
    );
    assert.equal(f.service.runs().length, 1);
  } finally {
    await f.service.close();
  }
});

test("repair117: CI collector begins before result I/O; unchanged polls retain approval, same-head new attempt invalidates it", async () => {
  const f = fixture("ci-attempt117");
  try {
    const id = await published(f),
      original = f.deps.github.observe.bind(f.deps.github);
    f.deps.github.observe = async (...args) => {
      assert.ok(
        f.service.store.coordinatorSnapshot(id).observations.ci,
        "collector token exists before collecting result",
      );
      return original(...args);
    };
    await f.service.refresh(id);
    await f.service.idle();
    assert.equal(
      f.service.run(id).phase,
      "awaiting_approval",
      f.service.run(id).message,
    );
    const head = f.service.run(id).head;
    await f.service.approve(id, head);
    const before = f.service.store.coordinatorSnapshot(id),
      approval = f.service.run(id).approval;
    await f.service.refresh(id);
    await f.service.idle();
    assert.deepEqual(f.service.run(id).approval, approval);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).observations.ci.generation,
      before.observations.ci.generation,
    );
    f.attempt = 2;
    await f.service.merge(id, head);
    await f.service.idle();
    assert.equal(f.counts().merges, 0);
    assert.equal(f.service.run(id).approval, null);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.approval,
      undefined,
    );
    assert.match(f.service.run(id).message, /CI|evidence|approval|attempt/);
  } finally {
    await f.service.close();
  }
});

test("repair117: approval rechecks the actual passing CI attempt on the same head", async () => {
  const f = fixture("ci-approve117");
  try {
    const id = await reviewed(f);
    f.attempt = 2;
    await assert.rejects(
      f.service.approve(id, f.service.run(id).head),
      /CI|evidence|attempt/,
    );
    assert.equal(f.service.run(id).approval, null);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.approval,
      undefined,
    );
  } finally {
    await f.service.close();
  }
});

test("repair117: upstream attempt changing during collection invalidates approval before discarding the delayed result", async () => {
  const f = fixture("ci-drift117");
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    await f.service.approve(id, head);
    const original = f.deps.github.observe.bind(f.deps.github);
    f.deps.github.observe = async (...args) => {
      f.attempt = 2;
      return original(...args);
    };
    await f.service.merge(id, head);
    await f.service.idle();
    assert.equal(f.counts().merges, 0);
    assert.equal(f.service.run(id).approval, null);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.approval,
      undefined,
    );
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.ci,
      undefined,
    );
    assert.match(
      f.service.run(id).message,
      /attempt changed during collection/,
    );
  } finally {
    await f.service.close();
  }
});

for (const scan of ["result", "final recheck"]) {
  test(
    "repair117 settlement: production GitHub detects a workflow rerun during the " +
      scan +
      " scan's last status await",
    async () => {
      const f = fixture("ci-production-late-drift-" + scan),
        gate = barrier();
      let attempt = 1,
        drift = false,
        statusReads = 0;
      const gh = new GitHub(async (_file, args) => {
        const path = args[1];
        if (path.includes("check-runs"))
          return JSON.stringify({
            total_count: 1,
            check_runs: [
              {
                id: 101,
                name: "fixture-check",
                check_suite: { id: 77 },
                status: "completed",
                conclusion: "success",
                html_url: "",
              },
            ],
          });
        if (path.includes("actions/runs"))
          return JSON.stringify({
            total_count: 1,
            workflow_runs: [
              {
                id: 301,
                workflow_id: 5,
                event: "pull_request",
                name: "unit workflow",
                run_attempt: attempt,
                check_suite_id: 77,
                status: "completed",
                conclusion: "success",
                html_url: "",
              },
            ],
          });
        assert.match(path, /\/status\?/);
        if (drift && ++statusReads === (scan === "result" ? 2 : 4)) {
          drift = false;
          await gate.wait();
        }
        return JSON.stringify({ total_count: 0, statuses: [] });
      });
      f.deps.github.attempts = gh.attempts.bind(gh);
      f.deps.github.observe = gh.observe.bind(gh);
      try {
        const id = await reviewed(f),
          head = f.service.run(id).head;
        await f.service.approve(id, head);
        f.deps.github.observe = async (...args) => {
          drift = true;
          statusReads = 0;
          return gh.observe(...args);
        };
        await f.service.merge(id, head);
        await gate.waiting;
        attempt = 2;
        gate.release();
        await f.service.idle();
        assert.equal(f.counts().merges, 0);
        assert.equal(f.counts().ready, 0);
        assert.equal(f.service.run(id).approval, null);
        const snapshot = f.service.store.coordinatorSnapshot(id);
        assert.equal(snapshot.receipts.ci, undefined);
        assert.equal(snapshot.receipts.approval, undefined);
        assert.match(
          f.service.run(id).message,
          /attempt changed during collection/,
        );
      } finally {
        gate.release();
        await f.service.close();
      }
    },
  );
}

test("repair117: cancelling while approval awaits CI cannot record consent or close SQLite before the await drains", async () => {
  const f = fixture("cancel-approve117"),
    gate = barrier(),
    original = f.deps.github.observe.bind(f.deps.github);
  try {
    const id = await reviewed(f),
      head = f.service.run(id).head;
    f.deps.github.observe = async (...args) => {
      await gate.wait();
      return original(...args);
    };
    const approval = f.service.approve(id, head);
    const rejected = assert.rejects(approval, /cancelled/);
    await gate.waiting;
    await f.service.cancel(id);
    gate.release();
    await rejected;
    await f.service.idle();
    assert.equal(f.service.run(id).phase, "cancelled");
    assert.equal(f.service.run(id).approval, null);
    assert.equal(
      f.service.store.coordinatorSnapshot(id).receipts.approval,
      undefined,
    );
  } finally {
    gate.release();
    await f.service.close();
  }
});

test("repair117: setup rejects an actual active owned workflow without changing its state or owner", async () => {
  const f = fixture("setup117"),
    gate = barrier(),
    original = f.deps.github.draft.bind(f.deps.github);
  f.deps.github.draft = async (...args) => {
    await gate.wait();
    return original(...args);
  };
  try {
    const run = await f.service.start();
    await gate.waiting;
    const processIdentity = identify(process.pid);
    writeFileSync(
      join(f.home, "daemon.json"),
      JSON.stringify({ process: processIdentity, url: "http://127.0.0.1:1" }),
    );
    const before = f.service.run(run.id);
    assert.throws(
      () =>
        execFileSync(process.execPath, ["dist/cli.js", "setup"], {
          env: { ...process.env, ROCKY_NEXT_HOME: f.home },
          stdio: "pipe",
        }),
      /running|owned|active|stop/i,
    );
    assert.deepEqual(f.service.run(run.id), before);
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.home, "daemon.json"))).process,
      processIdentity,
    );
  } finally {
    gate.release();
    await f.service.close();
  }
});

test("startup freezes the authority and runtime actually validated by preflight", async () => {
  const f = fixture("frozen-preflight");
  let authorities = 0,
    runtimes = 0;
  f.service.authority = () => {
    authorities++;
    return authorities === 1
      ? f.deps.authority
      : { ...f.deps.authority, repository: "wrong/target" };
  };
  f.service.runtime = () => {
    runtimes++;
    return f.deps.runtime;
  };
  try {
    const run = await f.service.start();
    await f.service.idle();
    assert.equal(
      f.service.detail(run.id).phase,
      "awaiting_ci",
      f.service.detail(run.id).message,
    );
    assert.equal(authorities, 1);
    assert.equal(runtimes, 1);
    assert.equal(
      f.service.store.operatorRecord("authority/" + run.id).repository,
      "synthetic/target",
    );
    const profile = await f.service.preflight();
    assert.deepEqual(
      profile.roles.map((r) => r.steps),
      [
        f.deps.runtime.roles.implementer.steps,
        f.deps.runtime.roles.reviewer.steps,
      ],
    );
  } finally {
    await f.service.close();
  }
});

test("repair117 settlement: a dirty active check settles its command without minting baseline readiness", async () => {
  const f = fixture("dirty-active-check");
  writeFileSync(
    join(f.repo, "check.mjs"),
    "import {writeFileSync} from 'node:fs';writeFileSync('index.mjs', 'export const label = \"check mutation\";\\n');\n",
  );
  execFileSync("git", ["add", "."], { cwd: f.repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "dirty check fixture",
    ],
    { cwd: f.repo, stdio: "pipe" },
  );
  try {
    const run = await f.service.start();
    await f.service.idle();
    const current = f.service.run(run.id),
      snapshot = f.service.store.coordinatorSnapshot(run.id);
    assert.equal(current.phase, "blocked");
    assert.match(current.message, /Checks modified committed source/);
    assert.equal(snapshot.execution, null);
    assert.equal(f.service.store.implementationSlot(), null);
    assert.equal(snapshot.receipts.baseline, undefined);
    assert.equal(snapshot.receipts.checks, undefined);
    assert.equal(snapshot.receipts.review, undefined);
    assert.equal(snapshot.receipts.approval, undefined);
    assert.equal(f.service.store.commands(run.id)[0].result.outcome, "success");
    assert.equal(f.agentPlan, null);
    assert.equal(f.counts().drafts, 0);
  } finally {
    await f.service.close();
  }
});

test("repair117 settlement: cancelling a real check releases the durable action and survives restart for explicit rerun", async () => {
  const f = fixture("cancel-check");
  writeFileSync(
    join(f.repo, "check.mjs"),
    "import {writeFileSync} from 'node:fs';writeFileSync('check-started', String(process.pid));setInterval(() => {}, 1000);\n",
  );
  execFileSync("git", ["add", "."], { cwd: f.repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "slow check",
    ],
    { cwd: f.repo, stdio: "pipe" },
  );
  try {
    const run = await f.service.start();
    const deadline = Date.now() + 10000;
    while (
      !existsSync(join(f.service.run(run.id).workspace, "check-started"))
    ) {
      assert.ok(Date.now() < deadline, "check started within deadline");
      await delay(25);
    }
    const action = f.service.store.coordinatorSnapshot(run.id).execution;
    await f.service.cancel(run.id);
    await f.service.idle();
    const commands = f.service.store.commands(run.id);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].state, "finished");
    assert.equal(commands[0].result.outcome, "cancelled");
    assert.equal(f.service.store.get(run.id).cancelled, true);
    assert.equal(f.counts().drafts, 0);
    assert.match(
      readFileSync(join(f.service.run(run.id).workspace, "index.mjs"), "utf8"),
      /before/,
    );
    assertCancelledSettlement(f.service, run.id, action.key);
    const receipt = f.service.store.effect(action.key).receipt;
    assert.equal(receipt.inputDigest, action.inputDigest);
    assert.equal(receipt.usage.source.kind, "local-no-model");
    assert.equal(receipt.usage.tokens, 0);
    await f.service.close();
    f.service = new OperatorService(f.home, f.deps);
    assertCancelledSettlement(f.service, run.id, action.key, receipt);
    writeFileSync(join(f.repo, "check.mjs"), "process.exit(0);\n");
    execFileSync("git", ["add", "."], { cwd: f.repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        "settled rerun check",
      ],
      { cwd: f.repo, stdio: "pipe" },
    );
    const next = await f.service.start({ previousRunId: run.id });
    await f.service.idle();
    assert.equal(f.service.run(next.id).phase, "awaiting_ci");
    assert.equal(
      f.service.store.coordinatorSnapshot(run.id).stage,
      "cancelled",
    );
  } finally {
    await f.service.close();
  }
});

for (const timing of ["running", "settled"]) {
  test(
    "repair117 settlement: cancelling a real agent " +
      timing +
      " retains native usage, releases the slot and permits restarted explicit rerun",
    async () => {
      let slow = timing === "running";
      const f = fixture("cancel-agent-settlement-" + timing, {
        agentScript(script) {
          return slow
            ? [{ stepStart: {} }, { marker: "agent-started" }, { sleep: 20000 }]
            : script;
        },
      });
      const gate = barrier(),
        originalFactory = f.deps.adapter;
      let result;
      f.deps.adapter = (...args) => {
        const adapter = originalFactory(...args),
          begin = adapter.begin.bind(adapter);
        adapter.begin = async (action) => {
          result = await begin(action);
          if (timing === "settled") await gate.wait();
          return result;
        };
        return adapter;
      };
      try {
        const run = await f.service.start();
        if (timing === "settled") await gate.waiting;
        else {
          const deadline = Date.now() + 10000;
          while (
            !f.agentPlan ||
            !existsSync(join(f.agentPlan.paths.parentTmp, "agent-started"))
          ) {
            assert.ok(Date.now() < deadline, "real agent process started");
            await delay(25);
          }
        }
        const action = f.service.store.coordinatorSnapshot(run.id).execution;
        await f.service.cancel(run.id);
        gate.release();
        await f.service.idle();
        assert.equal(result.quiescent, true);
        assert.equal(result.usage.schema, 2);
        assertCancelledSettlement(f.service, run.id, action.key, result);
        assert.equal(
          f.service.store.coordinatorSnapshot(run.id).head,
          f.service.run(run.id).base,
        );
        assert.match(
          readFileSync(
            join(f.service.run(run.id).workspace, "index.mjs"),
            "utf8",
          ),
          /before/,
        );
        assert.equal(f.counts().drafts, 0);
        assert.equal(
          f.service.store.coordinatorSnapshot(run.id).receipts.review,
          undefined,
        );
        if (timing === "settled")
          assert.equal(
            f.service.store.coordinatorSnapshot(run.id).budgets
              .harnessReportedTokens,
            1540,
          );
        await f.service.close();
        slow = false;
        f.deps.adapter = originalFactory;
        f.service = new OperatorService(f.home, f.deps);
        assertCancelledSettlement(f.service, run.id, action.key, result);
        const next = await f.service.start({ previousRunId: run.id });
        await f.service.idle();
        assert.equal(f.service.run(next.id).phase, "awaiting_ci");
        assert.equal(
          f.service.store.coordinatorSnapshot(run.id).stage,
          "cancelled",
        );
      } finally {
        gate.release();
        await f.service.close();
      }
    },
  );
}

test("real SQLite + fake OpenCode process: checks, draft, CI/review, exact-head approval, merge and manual closeout", async () => {
  const f = fixture("complete");
  const { service } = f;
  try {
    const run = await service.start();
    await service.idle();
    let d = service.detail(run.id);
    assert.equal(d.phase, "awaiting_ci", d.message);
    assert.equal(d.snapshot.receipts.checks.outcome, "pass");
    assert.equal(f.counts().drafts, 1);
    assert.match(
      readFileSync(join(f.repo, "index.mjs"), "utf8"),
      /before/,
      "original checkout unchanged",
    );
    assert.match(readFileSync(join(d.workspace, "index.mjs"), "utf8"), /after/);
    await service.refresh(run.id);
    await service.idle();
    d = service.detail(run.id);
    assert.equal(d.phase, "awaiting_approval", d.message);
    assert.equal(d.snapshot.stage, "handoff_ready");
    await assert.rejects(service.approve(run.id, "a".repeat(40)), /not ready/);
    d = await service.approve(run.id, d.head);
    assert.equal(d.approval.head, d.head);
    assert.equal(d.snapshot.receipts.approval.outcome, "pass");
    await service.merge(run.id, d.head);
    await service.idle();
    d = service.detail(run.id);
    assert.equal(d.phase, "merged", d.message);
    assert.equal(d.pr.mergeCommit, "f".repeat(40));
    d = service.closeout(run.id, "Synthetic tracker closeout verified");
    assert.equal(d.phase, "closed");
    assert.ok(d.closedAt);
    assert.deepEqual(f.counts(), { drafts: 1, merges: 1, ready: 1 });
    writeFileSync(
      join(f.home, "result.json"),
      JSON.stringify(
        {
          scope:
            "owned-fake-cli and fake GitHub; real git/check processes/SQLite",
          run: d,
        },
        null,
        2,
      ),
    );
  } finally {
    await service.close();
  }
});

test("changed remote head after exact approval refuses merge and records stale approval", async () => {
  const f = fixture("stale");
  const s = f.service;
  try {
    const run = await s.start();
    await s.idle();
    assert.equal(
      s.detail(run.id).phase,
      "awaiting_ci",
      s.detail(run.id).message,
    );
    await s.refresh(run.id);
    await s.idle();
    const d = s.detail(run.id);
    await s.approve(run.id, d.head);
    f.pr = { ...f.pr, head: "b".repeat(40) };
    await s.merge(run.id, d.head);
    await s.idle();
    const result = s.detail(run.id);
    assert.equal(result.phase, "blocked");
    assert.match(result.message, /Stale approval/);
    assert.equal(result.approval, null);
    assert.equal(f.counts().merges, 0);
  } finally {
    await s.close();
  }
});

test("CI collector distinguishes head/integration and never promotes absent required checks", async () => {
  const gh = new GitHub(async (file, args) => {
    const path = args[1];
    if (path.includes("check-runs"))
      return JSON.stringify({
        total_count: 1,
        check_runs: [
          {
            id: 101,
            name: "unit",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/check",
          },
        ],
      });
    if (path.includes("actions/runs"))
      return JSON.stringify({ total_count: 0, workflow_runs: [] });
    return JSON.stringify({ total_count: 0, statuses: [] });
  });
  const pr = { head: "a".repeat(40), integration: "b".repeat(40) };
  const pending = await gh.observe("owner/repo", pr, ["missing"], "/tmp");
  assert.equal(pending.outcome, "pending");
  assert.deepEqual(
    new Set(pending.checks.map((c) => c.sha)),
    new Set([pr.head, pr.integration]),
  );
  assert.equal(
    (await gh.observe("owner/repo", pr, ["unit"], "/tmp")).outcome,
    "pass",
  );
  assert.equal(
    (
      await gh.observe(
        "owner/repo",
        { ...pr, integration: null },
        ["unit"],
        "/tmp",
      )
    ).outcome,
    "pending",
  );
});

test("failed baseline stops before any agent or GitHub write", async () => {
  const f = fixture("baseline-failure");
  writeFileSync(join(f.repo, "check.mjs"), "process.exit(1);\n");
  execFileSync("git", ["add", "."], { cwd: f.repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "failing baseline",
    ],
    { cwd: f.repo, stdio: "pipe" },
  );
  try {
    const run = await f.service.start();
    await f.service.idle();
    const d = f.service.detail(run.id);
    assert.equal(d.phase, "blocked");
    assert.match(d.message, /Baseline/);
    assert.equal(d.snapshot.receipts.baseline.outcome, "fail");
    assert.equal(d.commands.length, 1);
    assert.equal(f.counts().drafts, 0);
  } finally {
    await f.service.close();
  }
});

test("restart preserves unfinished work as recovery required without relaunch", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-recovery-"));
  let service = new OperatorService(home);
  service.store.saveOperatorRecord("run/interrupted", {
    id: "interrupted",
    phase: "implementing",
    message: "",
    createdAt: 1,
  });
  await service.close();
  service = new OperatorService(home);
  assert.equal(service.run("interrupted").phase, "recovery_required");
  await assert.rejects(service.start(), /unreconciled/);
  await service.close();
});

test("repair117: fixed ATT-764 identity also covers blocked admissions and refuses a second service owner", async () => {
  const f = fixture("att-issue117");
  try {
    f.service.configure({
      ...f.service.config(),
      repository: "attraccess/attraccess",
      task: ATT764_TASK,
    });
    const run = await f.service.start();
    assert.equal(run.issue, "ATT-764");
    assert.equal(run.phase, "blocked");
    await assert.rejects(f.service.start(), /explicit|issue|rerun/i);
    assert.throws(
      () => new OperatorService(f.home, f.deps),
      /active|owned|running/,
    );
    assert.equal(f.service.runs().length, 1);
  } finally {
    await f.service.close();
  }
});

test("repair117: genuinely killed owner recovers retained active state without relaunch", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-orphan117-"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {OperatorService} from './dist/daemon/service.js';const s=new OperatorService(process.argv[1]);s.store.saveOperatorRecord('run/orphan',{id:'orphan',phase:'publishing',message:'',createdAt:1});console.log('ready');setInterval(()=>{},1000);`,
      home,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error("Owner exited before ready: " + code)),
      );
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const service = new OperatorService(home);
    try {
      assert.equal(service.run("orphan").phase, "recovery_required");
      await assert.rejects(service.start(), /unreconciled/);
      assert.equal(service.runs().length, 1);
    } finally {
      await service.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
});

test("repair117: CI binds real check-run, workflow attempt and status IDs while identical polls stay stable", async () => {
  let attempt = 1,
    status = 201;
  const gh = new GitHub(async (_file, args) => {
    const path = args[1];
    if (path.includes("check-runs"))
      return JSON.stringify({
        total_count: 1,
        check_runs: [
          {
            id: 101,
            name: "unit",
            check_suite: { id: 77 },
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/owner/repo/actions/runs/301/job/101",
          },
        ],
      });
    if (path.includes("actions/runs"))
      return JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 301,
            workflow_id: 5,
            event: "pull_request",
            name: "unit workflow",
            run_attempt: attempt,
            check_suite_id: 77,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/owner/repo/actions/runs/301",
          },
        ],
      });
    return JSON.stringify({
      total_count: 1,
      statuses: [
        {
          id: status,
          context: "external",
          state: "success",
          target_url: "https://ci.example/status",
        },
      ],
    });
  });
  const pr = { head: "a".repeat(40), integration: "b".repeat(40) };
  const first = await gh.attempts("owner/repo", pr, "/tmp");
  assert.deepEqual(await gh.attempts("owner/repo", pr, "/tmp"), first);
  assert.equal(
    first.identities.find((x) => x.source === "check-run").workflowAttempt,
    1,
  );
  assert.ok(
    first.identities.some((x) => x.source === "status" && x.id === 201),
  );
  attempt = 2;
  assert.notDeepEqual(await gh.attempts("owner/repo", pr, "/tmp"), first);
  status = 202;
  const current = await gh.observe(
    "owner/repo",
    pr,
    ["unit", "external"],
    "/tmp",
  );
  assert.equal(current.outcome, "pass");
  assert.ok(
    current.attempts.identities.some(
      (x) => x.source === "status" && x.id === 202,
    ),
  );
  assert.equal(
    current.checks.find((x) => x.source === "check-run").workflowAttempt,
    2,
  );
});

test("draft creation rechecks cancellation after push before creating a PR", async () => {
  const calls = [];
  let cancelled = false;
  const gh = new GitHub(async (file, args) => {
    calls.push([file, args]);
    cancelled = true;
    return "";
  });
  await assert.rejects(
    gh.draft(
      "owner/repo",
      "rocky/test",
      "main",
      "a".repeat(40),
      "/tmp",
      "fixture",
      () => {
        if (cancelled) throw new Error("cancelled");
      },
    ),
    /cancelled/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "git");
});
