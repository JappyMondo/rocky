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
import { execFileSync } from "node:child_process";
import { OperatorService } from "../dist/daemon/service.js";
import { serve } from "../dist/daemon/server.js";
import { defaults } from "../dist/daemon/config.js";
import { execute, GitHub } from "../dist/delivery/github.js";
import { OpencodeAdapter } from "../dist/agents/opencode/index.js";
import { delay } from "../dist/runner/process.js";
import {
  opencodeFixture,
  finalProposal,
  successScript,
  defaultExportMarker,
} from "./opencode-support.mjs";

function fixture(name) {
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
  let pr = null,
    merges = 0,
    drafts = 0,
    ready = 0;
  const github = {
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
        head: p.head,
        integration: p.integration,
        outcome: "pass",
        checks: [
          {
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
    execute,
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
        const plan = original(action, {
          ...input,
          prompt: JSON.stringify(script),
        });
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
    get pr() {
      return pr;
    },
    set pr(v) {
      pr = v;
    },
    counts: () => ({ drafts, merges, ready }),
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

test("cancelling a running local check drains its command and prevents agent or publication", async () => {
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
  } finally {
    await f.service.close();
  }
});

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
            name: "unit",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/check",
          },
        ],
      });
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
