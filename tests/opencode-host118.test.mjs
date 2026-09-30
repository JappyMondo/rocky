import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { assertOpencodeDataHomeIsolation } from "../dist/agents/opencode/launch.js";
import { opencodeFixture } from "./opencode-support.mjs";

test("host118 auth admission rejects a readable-by-others file without reading its contents", () => {
  const f = opencodeFixture("metadata118");
  try {
    chmodSync(join(f.dataHome, "opencode/auth.json"), 0o644);
    assert.throws(
      () =>
        assertOpencodeDataHomeIsolation(
          f.dataHome,
          f.config.hostIdentity.userHome,
        ),
      /auth.*mode/,
    );
  } finally {
    f.store.close();
  }
});

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  cpSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  OpencodeWorkerClient,
  assertAgentObservation,
  OpencodeAdapter,
  dependencyInventory,
  inspectDependencyTemplate,
  verifyDependencyTemplate,
  materializeDependencies,
  bindHostAdmission,
  qualificationForManifest,
  assertHostAdmission,
  roleConfigContent,
  identity,
  digest,
} from "../dist/index.js";
import {
  baselinePass,
  schedule,
  finalProposal,
  successScript,
  defaultExportMarker,
  dispatchOpencode,
  closeFixture,
  waitForFile,
  readReceipt,
  exportDoc,
} from "./opencode-support.mjs";
import { validateWorkerMessage } from "../dist/agents/opencode/worker-protocol.js";
import { delay, identify, groupAbsent } from "../dist/runner/process.js";

async function workerFixture(name, scriptOptions = {}) {
  const f = opencodeFixture(name);
  baselinePass(f);
  f.action = schedule(f, "implement");
  f.worker = new OpencodeWorkerClient(f.store, f.lease, f.config);
  f.adapter = f.worker;
  const script = successScript(
    finalProposal(f.action, "implementer"),
    scriptOptions,
  );
  f.plan = await f.worker.prepareLaunch(f.action, {
    prompt: JSON.stringify(script),
    stage(src) {
      writeFileSync(join(src, "before.txt"), "host staged\n");
    },
  });
  writeFileSync(
    join(f.plan.paths.parentTmp, "fake-export.json"),
    JSON.stringify(defaultExportMarker(f.plan)),
  );
  return f;
}
async function cleanupWorker(f) {
  await f.worker?.close();
  await closeFixture(f);
}

test("host118 actual clean worker retains native artifacts while host keeps its signing socket environment", async () => {
  // No inherited authentication values enter this owned synthetic host subprocess.
  const code = `import {opencodeFixture,baselinePass,schedule,finalProposal,successScript,defaultExportMarker} from './tests/opencode-support.mjs'; import{OpencodeWorkerClient,assertAgentObservation}from'./dist/index.js';import{writeFileSync,readFileSync}from'node:fs';import{join,dirname}from'node:path'; const f=opencodeFixture('clean-host118');baselinePass(f);const a=schedule(f,'implement');const w=new OpencodeWorkerClient(f.store,f.lease,f.config);const p=await w.prepareLaunch(a,{prompt:JSON.stringify(successScript(finalProposal(a,'implementer')))});writeFileSync(join(p.paths.parentTmp,'fake-export.json'),JSON.stringify(defaultExportMarker(p))); await f.store.dispatchCoordinator(f.lease,a.key,w); const r=f.store.operatorRecord('opencode-observation/'+a.key).settlement;const event={type:'result',actionKey:a.key,inputDigest:a.inputDigest,outcome:r.outcome,head:r.head,usage:r.usage,quiescent:r.quiescent,detail:r.detail};assertAgentObservation(f.store,f.config,p,event);const m=JSON.parse(readFileSync(join(dirname(f.runsRoot),'workers', (await import('./dist/store/json.js')).digest(a.key),'worker.json')));console.log(JSON.stringify({hostHasSocket:Object.hasOwn(process.env,'SSH_AUTH_SOCK'),workerNames:m.sourceEnvNames,evidenceClass:f.config.evidenceClass}));await w.close();f.store.close();`;
  const result = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      env: {
        PATH: "/usr/bin:/bin",
        SSH_AUTH_SOCK: "SYNTHETIC-unused-signing-context",
        OPENCODE_ARTIFACT_ROOT: process.env.OPENCODE_ARTIFACT_ROOT,
        COORDINATOR_ARTIFACT_ROOT: process.env.COORDINATOR_ARTIFACT_ROOT,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const observation = JSON.parse(result.trim());
  assert.equal(observation.hostHasSocket, true);
  assert.equal(observation.workerNames.includes("SSH_AUTH_SOCK"), false);
  assert.equal(observation.evidenceClass, "owned-fake-cli");
});

test("host118 poisoned ACTUAL worker environment refuses before staging/native dispatch", async () => {
  const f = opencodeFixture("poison-worker118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const directory = join(f.dir, "poisoned-worker");
    mkdirSync(directory, { mode: 0o700 });
    const request = {
      schema: 1,
      nonce: "owned-test",
      db: f.store.path,
      lease: f.lease,
      action,
      config: f.config,
      prompt: "not consumed",
      directory,
    };
    const file = join(directory, "request.json");
    writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      ["dist/agents/opencode/worker.js", file],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: directory,
          TMPDIR: directory,
          SSH_AUTH_SOCK: "SYNTHETIC",
        },
      },
    );
    await once(child, "exit");
    assert.match(
      JSON.parse(readFileSync(join(directory, "failure.json"))).message,
      /forbidden-env-present:SSH_AUTH_SOCK/,
    );
    assert.equal(f.store.duplexInvocation(action.key) ?? null, null);
    assert.equal((await import("node:fs")).readdirSync(f.runsRoot).length, 0);
  } finally {
    f.store.close();
  }
});

test("host118 host independently rejects forged plan resource/protocol bounds and receipt drift", async () => {
  const f = await workerFixture("forged-plan118");
  try {
    const request = JSON.parse(
      readFileSync(
        join(
          dirname(f.runsRoot),
          "workers",
          digest(f.action.key),
          "request.json",
        ),
      ),
    );
    for (const mutate of [
      (p) => p.spec.timeoutMs++,
      (p) => p.spec.cleanupMs++,
      (p) => p.spec.logBytes++,
      (p) => p.limits.outputFrames++,
      (p) => p.streamLimits.maxFrames++,
      (p) => p.expectations.maxParts++,
      (p) => p.binaryC0.bytes++,
      (p) => (p.extra = "forged"),
    ]) {
      const forged = structuredClone(f.plan);
      mutate(forged);
      assert.throws(
        () => f.worker.verifyPlan(forged, request, f.plan.paths),
        /plan-binding/,
      );
    }
    assert.throws(
      () =>
        validateWorkerMessage(
          {
            schema: 1,
            nonce: "wrong",
            actionKey: f.action.key,
            type: "begin",
            payload: null,
          },
          request,
        ),
      /protocol/,
    );
    const pending = f.store.dispatchCoordinator(
      f.lease,
      f.action.key,
      f.worker,
    );
    f.pending = pending;
    f.activeAction = f.action;
    await pending;
    const stored = f.store.operatorRecord(
        "opencode-observation/" + f.action.key,
      ),
      s = stored.settlement;
    const result = {
      type: "result",
      actionKey: f.action.key,
      inputDigest: f.action.inputDigest,
      outcome: s.outcome,
      head: s.head,
      quiescent: s.quiescent,
      usage: s.usage,
      detail: s.detail,
    };
    const admitted = assertAgentObservation(f.store, f.config, f.plan, result);
    assert.equal(admitted.admission, "owned-fake-only");
    writeFileSync(stored.receipt.path, "corrupt retained receipt");
    assert.throws(
      () => assertAgentObservation(f.store, f.config, f.plan, result),
      /artifact/,
    );
  } finally {
    await cleanupWorker(f);
  }
});

test("host118 cancellation while clean worker is preparing has durable no-dispatch settlement", async () => {
  const f = opencodeFixture("prepare-cancel118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const worker = new OpencodeWorkerClient(f.store, f.lease, f.config);
    f.worker = worker;
    const pending = worker.prepareLaunch(action, {
      prompt: JSON.stringify(
        successScript(finalProposal(action, "implementer")),
      ),
      stage() {
        f.store.ingestCoordinator(action.runId, "control", "cancel118", {
          type: "cancel",
        });
        f.store.applyCoordinator(
          f.lease,
          f.store.coordinatorSnapshot(action.runId).revision,
          "control",
          "cancel118",
        );
        f.store.cancel(action.runId);
      },
    });
    await assert.rejects(pending, /cancel/);
    const result = await worker.notDispatched(
      action,
      "cancelled during prepare",
    );
    assert.equal(result.quiescent, true);
    assert.equal(result.usage.status, "unknown");
    assert.equal(f.store.duplexInvocation(action.key) ?? null, null);
    f.store.ingestCoordinator(
      action.runId,
      "transport",
      "not-dispatched118",
      result,
    );
    const s = f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(action.runId).revision,
      "transport",
      "not-dispatched118",
    );
    assert.equal(s.execution, null);
    assert.equal(f.store.implementationSlot(), null);
  } finally {
    await f.worker?.close();
    f.store.close();
  }
});

test("host118 cancellation after queued IPC begin but before worker execution starts zero native children", async () => {
  const f = await workerFixture("begin-cancel118");
  try {
    const dir = join(dirname(f.runsRoot), "workers", digest(f.action.key));
    const pid = JSON.parse(readFileSync(join(dir, "worker.json"))).process.pid;
    process.kill(pid, "SIGSTOP");
    const pending = f.store.dispatchCoordinator(
      f.lease,
      f.action.key,
      f.worker,
    );
    f.pending = pending;
    f.activeAction = f.action;
    f.store.ingestCoordinator(f.action.runId, "control", "cancel", {
      type: "cancel",
    });
    f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(f.action.runId).revision,
      "control",
      "cancel",
    );
    f.store.cancel(f.action.runId);
    process.kill(pid, "SIGCONT");
    await pending;
    assert.equal(f.store.duplexInvocation(f.action.key) ?? null, null);
    const s = f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(f.action.runId).revision,
      "transport",
      "result/" + f.action.key,
    );
    assert.equal(s.execution, null);
    assert.equal(f.store.implementationSlot(), null);
  } finally {
    await cleanupWorker(f);
  }
});

for (const loss of ["disconnect", "death"])
  test(
    "host118 " +
      loss +
      " does not renew lease, export or resend; supervised evidence survives",
    async () => {
      const f = await workerFixture("worker-loss118-" + loss, {
        afterStepStart: [
          { marker: "ready118" },
          { waitFile: "never118", timeoutMs: 20000 },
        ],
      });
      try {
        f.store.renew(f.lease, 1000);
        const inspect = new DatabaseSync(f.store.path);
        const expiry = Number(
          inspect
            .prepare("SELECT expires FROM runs WHERE id=?")
            .get(f.lease.runId).expires,
        );
        const pending = f.store.dispatchCoordinator(
          f.lease,
          f.action.key,
          f.worker,
        );
        f.pending = pending;
        f.activeAction = f.action;
        await waitForFile(join(f.plan.paths.parentTmp, "ready118"));
        const pid = JSON.parse(
          readFileSync(
            join(
              dirname(f.runsRoot),
              "workers",
              digest(f.action.key),
              "worker.json",
            ),
          ),
        ).process.pid;
        if (loss === "death") process.kill(pid, "SIGKILL");
        else f.worker.child.disconnect();
        await pending;
        const c = f.store.duplexInvocation(f.action.key);
        assert.equal(c.state, "finished");
        assert.equal(c.duplex.sends.filter((s) => s.end).length, 1);
        assert.equal(
          (await import("node:fs")).existsSync(
            join(f.plan.paths.parentTmp, "fake-export-record.json"),
          ),
          false,
        );
        assert.equal(
          Number(
            inspect
              .prepare("SELECT expires FROM runs WHERE id=?")
              .get(f.lease.runId).expires,
          ),
          expiry,
          "worker must not renew original host expiry",
        );
        inspect.close();
        await delay(Math.max(1, expiry - Date.now() + 50));
        assert.throws(() => f.store.assertLease(f.lease), /stale-lease/);
        assert.throws(() => f.worker.begin(f.action), /begin-binding/);
        assert.ok(lstatSync(c.result.stdout).isFile());
      } finally {
        await cleanupWorker(f);
      }
    },
  );

test("host118 finished-command cancellation before export retains quiescent result without another child", async () => {
  const f = opencodeFixture("cancel-export118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const original = f.adapter.settleCommand.bind(f.adapter);
    f.adapter.settleCommand = (plan, id, record, quiescent) => {
      f.store.cancel(action.runId);
      return original(plan, id, record, quiescent);
    };
    const { plan, pending } = dispatchOpencode(
      f,
      action,
      successScript(finalProposal(action, "implementer")),
    );
    await pending;
    const record = f.store.duplexInvocation(action.key);
    const receipt = readReceipt(plan, record.id);
    assert.equal(receipt.lifecycle.quiescent, true);
    assert.equal(receipt.usage.status, "unknown");
    assert.equal(receipt.exportAudit.ran, false);
    assert.equal(
      (await import("node:fs")).existsSync(
        join(plan.paths.parentTmp, "fake-export-record.json"),
      ),
      false,
    );
    f.store.ingestCoordinator(action.runId, "control", "cancel-finish", {
      type: "cancel",
    });
    f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(action.runId).revision,
      "control",
      "cancel-finish",
    );
    const s = f.store.applyCoordinator(
      f.lease,
      f.store.coordinatorSnapshot(action.runId).revision,
      "transport",
      "result/" + action.key,
    );
    assert.equal(s.execution, null);
    assert.equal(f.store.implementationSlot(), null);
  } finally {
    await closeFixture(f);
  }
});

test("host118 auth metadata rejects symlinks and public parents without opening auth bytes", async () => {
  const f = opencodeFixture("auth-metadata118");
  const fs = (await import("node:fs")).default,
    original = fs.readFileSync;
  const { syncBuiltinESMExports } = await import("node:module");
  const auth = join(f.dataHome, "opencode/auth.json");
  let opens = 0;
  try {
    fs.readFileSync = (path, ...args) => {
      if (String(path) === auth) {
        opens++;
        throw new Error("auth must not be opened");
      }
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    assert.equal(
      assertOpencodeDataHomeIsolation(
        f.dataHome,
        f.config.hostIdentity.userHome,
      ).authMetadata.mode,
      0o600,
    );
    chmodSync(f.dataHome, 0o755);
    assert.throws(
      () =>
        assertOpencodeDataHomeIsolation(
          f.dataHome,
          f.config.hostIdentity.userHome,
        ),
      /parent-mode/,
    );
    chmodSync(f.dataHome, 0o700);
    rmSync(auth);
    const target = join(f.dir, "synthetic-auth-marker");
    writeFileSync(target, "SYNTHETIC nonsecret", { mode: 0o600 });
    symlinkSync(target, auth);
    assert.throws(
      () =>
        assertOpencodeDataHomeIsolation(
          f.dataHome,
          f.config.hostIdentity.userHome,
        ),
      /auth-not-regular/,
    );
    assert.equal(opens, 0);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
    f.store.close();
  }
});

function structuralTemplate(dir) {
  // Owned structural fixture only. Actual npm ci/integrity proof is retained separately, never minted here.
  mkdirSync(join(dir, "node_modules/@opencode-ai/plugin"), {
    recursive: true,
    mode: 0o700,
  });
  const integrity =
    "sha512-fmhqCBJvNt+Vfbx6ckKP19S3xwMBhUXLCBQaK92R4wnv3wsWTZYkJQwYf2egiWfJNOl47jhs3vP7uQkl0mvHQw==";
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@opencode-ai/plugin": "1.18.33" },
    }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@opencode-ai/plugin": "1.18.33" } },
        "node_modules/@opencode-ai/plugin": { version: "1.18.33", integrity },
      },
    }),
  );
  writeFileSync(
    join(dir, "node_modules/@opencode-ai/plugin/package.json"),
    JSON.stringify({ version: "1.18.33", synthetic: "structural-test-only" }),
  );
  return inspectDependencyTemplate(dir);
}
test("host118 template verification rejects empty sentinels, inventory drift and escaping links", () => {
  const f = opencodeFixture("template118");
  try {
    const root = join(f.dir, "dependencies");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    assert.throws(() => inspectDependencyTemplate(root), /ENOENT/);
    const t = structuralTemplate(root);
    const cfg = join(f.dir, "cfg");
    mkdirSync(cfg, { mode: 0o700 });
    materializeDependencies(t, cfg);
    assert.equal(dependencyInventory(join(cfg, "opencode")), t.inventorySha256);
    writeFileSync(
      join(root, "node_modules/@opencode-ai/plugin/changed"),
      "drift",
    );
    assert.throws(() => verifyDependencyTemplate(t), /template-drift/);
    symlinkSync(f.modelsCatalog.path, join(root, "escape"));
    assert.throws(() => inspectDependencyTemplate(root), /external-link/);
  } finally {
    f.store.close();
  }
});

function hostManifestFixture(f) {
  const root = join(f.dir, "qualification");
  mkdirSync(root, { mode: 0o700 });
  const dependencies = structuralTemplate(join(root, "dependencies"));
  const artifact = (name, value) => {
    const path = join(root, name);
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes), bytes: bytes.length };
  };
  const context = {
    repository: "synthetic/target",
    task: null,
    profile: null,
    checks: [{ name: "fixture", file: process.execPath, args: [] }],
    requiredCI: ["fixture"],
    liveApproval: "SYNTHETIC-test-not-live",
    nativeProbeEvidence: "SYNTHETIC-roster-test",
    authBoundaryApproval: "SYNTHETIC-no-auth-boundary",
  };
  const config = { ...f.config };
  const roles = {};
  for (const role of ["implementer", "reviewer"]) {
    const name = "rocky-" + role;
    const tools =
      role === "reviewer"
        ? ["read", "glob", "grep"]
        : ["bash", "read", "glob", "grep", "edit", "write", "todowrite"];
    roles[role] = {
      argv: ["debug", "agent", name],
      exitCode: 0,
      quiescent: true,
      raw: artifact(role + ".json", {
        name,
        model: { providerID: "alibaba-token-plan", modelID: "qwen3.8-max" },
        steps: config.roles[role].steps,
        prompt: config.roles[role].prompt,
        tools: Object.fromEntries(tools.map((t) => [t, true])),
      }),
    };
  }
  const rosterEvidence = artifact("roster.json", {
    schema: 1,
    evidenceClass: "native-zero-turn",
    binary: config.binary,
    configContentSha256: digest(roleConfigContent(config)),
    catalogSha256: config.modelsCatalog.sha256,
    dependencyInventorySha256: dependencies.inventorySha256,
    sealedRecipe: "opencode-sealed-v1",
    roles,
  });
  const authBoundary = {
    accepted: true,
    reference: context.authBoundaryApproval,
    evidence: artifact("decision.json", {
      schema: 1,
      accepted: true,
      reference: context.authBoundaryApproval,
      boundary: "plain-0600-auth-file-bash-reachability",
      synthetic: "TEST ONLY",
    }),
  };
  const hostAdmission = bindHostAdmission(config, {
    context,
    authBoundary,
    nativeEvidence: [roles.implementer.raw],
    rosterEvidence,
    dependencies,
  });
  config.hostAdmission = hostAdmission;
  config.qualification = qualificationForManifest(hostAdmission);
  return config;
}
test("host118 host binding is conditional, recomputed, noncircular and refuses evidence/budget/config drift", () => {
  const f = opencodeFixture("manifest118");
  try {
    const config = hostManifestFixture(f);
    assert.equal(
      assertHostAdmission(config).status,
      "first-live-observation-required",
    );
    const changed = structuredClone(config);
    changed.roles.implementer.steps++;
    assert.throws(() => assertHostAdmission(changed), /runtime-binding/);
    const changedContext = structuredClone(config.hostAdmission.context);
    changedContext.requiredCI.push("different");
    assert.throws(
      () => assertHostAdmission(config, changedContext),
      /authority-drift/,
    );
    const undecided = structuredClone(config);
    undecided.hostAdmission.authBoundary.accepted = false;
    const { binding: _binding, ...payload } = undecided.hostAdmission;
    undecided.hostAdmission.binding = identity(payload);
    undecided.qualification = qualificationForManifest(undecided.hostAdmission);
    assert.throws(() => assertHostAdmission(undecided));
    writeFileSync(
      config.hostAdmission.authBoundary.evidence.path,
      "changed nonsecret decision",
    );
    assert.throws(() => assertHostAdmission(config), /artifact/);
  } finally {
    f.store.close();
  }
});

test("host118 immutable receipt retention failure returns retained failed settlement with measured usage", async () => {
  const f = opencodeFixture("retention118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const original = f.adapter.settleCommand.bind(f.adapter);
    f.adapter.settleCommand = (plan, id, record, quiet) => {
      mkdirSync(join(plan.paths.logs, "receipt-" + id + ".json"));
      return original(plan, id, record, quiet);
    };
    const { pending } = dispatchOpencode(
      f,
      action,
      successScript(finalProposal(action, "implementer")),
    );
    await pending;
    const observation = f.store.operatorRecord(
      "opencode-observation/" + action.key,
    );
    assert.equal(observation.receipt, null);
    assert.equal(observation.settlement.outcome, "failed");
    assert.equal(observation.settlement.usage.status, "reported");
    assert.match(observation.settlement.detail, /retention-failed/);
  } finally {
    await closeFixture(f);
  }
});

test("host118 zero reported totals and export retention failure cannot satisfy host admission", async () => {
  for (const fault of ["zero", "export-retention"]) {
    const f = opencodeFixture("positive-gate118-" + fault);
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const tokens = {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      if (fault === "export-retention") {
        const original = f.adapter.settleCommand.bind(f.adapter);
        f.adapter.settleCommand = (plan, id, record, quiet) => {
          mkdirSync(join(plan.paths.logs, "export-" + id + ".json"));
          return original(plan, id, record, quiet);
        };
      }
      const { plan, pending } = dispatchOpencode(
        f,
        action,
        successScript(
          finalProposal(action, "implementer"),
          fault === "zero" ? { tokens } : {},
        ),
        fault === "zero"
          ? { exportMarker: (p) => defaultExportMarker(p, { tokens }) }
          : {},
      );
      await pending;
      const o = f.store.operatorRecord("opencode-observation/" + action.key),
        s = o.settlement;
      const event = {
        type: "result",
        actionKey: action.key,
        inputDigest: action.inputDigest,
        outcome: s.outcome,
        head: s.head,
        quiescent: s.quiescent,
        usage: s.usage,
        detail: s.detail,
      };
      assert.throws(
        () => assertAgentObservation(f.store, f.config, plan, event),
        /observation/,
      );
      assert.equal(
        s.usage.status,
        fault === "zero" ? "ambiguous-zero" : "unknown",
      );
    } finally {
      await closeFixture(f);
    }
  }
});

test("host118 metadata admission refuses a foreign owner", async () => {
  const f = opencodeFixture("auth-owner118"),
    fs = (await import("node:fs")).default,
    original = fs.lstatSync,
    { syncBuiltinESMExports } = await import("node:module");
  try {
    fs.lstatSync = (path, ...args) => {
      const stat = original(path, ...args);
      return String(path).endsWith("/auth.json")
        ? new Proxy(stat, {
            get(target, key) {
              return key === "uid"
                ? process.getuid() + 1
                : Reflect.get(target, key);
            },
          })
        : stat;
    };
    syncBuiltinESMExports();
    assert.throws(
      () =>
        assertOpencodeDataHomeIsolation(
          f.dataHome,
          f.config.hostIdentity.userHome,
        ),
      /auth-owner/,
    );
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
    f.store.close();
  }
});

test("host118 rendered implementer denies the native invalid tool outside the reviewed roster", () => {
  const f = opencodeFixture("native-invalid118");
  try {
    const content = JSON.parse(roleConfigContent(f.config));
    assert.equal(content.agent["rocky-implementer"].permission.invalid, "deny");
  } finally {
    f.store.close();
  }
});

import { Store } from "../dist/store/index.js";
import { settlementToResultEvent } from "../dist/agents/seam.js";
for (const mode of [
  "same-adapter",
  "reopened-store",
  "receipt-before-pointer-crash",
]) {
  test(`host118 immutable terminal replay ${mode} preserves exact native event and never exports again`, async () => {
    const f = opencodeFixture("replay118-" + mode);
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const { plan, pending } = dispatchOpencode(
        f,
        action,
        successScript(finalProposal(action, "implementer")),
      );
      await pending;
      const key = "opencode-observation/" + action.key;
      const prior = f.store.operatorRecord(key);
      assert.equal(prior.settlement.classification, "complete");
      const bytes = readFileSync(prior.receipt.path);
      const exportRecord = readFileSync(
        join(plan.paths.parentTmp, "fake-export-record.json"),
      );
      const nativeRecord = readFileSync(
        join(plan.paths.parentTmp, "fake-record.json"),
      );
      const commandCount = f.store.commands(action.runId).length;
      f.store.applyCoordinator(
        f.lease,
        f.store.coordinatorSnapshot(action.runId).revision,
        "transport",
        `result/${action.key}`,
      );
      const settledSnapshot = f.store.coordinatorSnapshot(action.runId);
      if (mode !== "same-adapter") {
        f.pending = null;
        f.store.close();
        if (mode === "receipt-before-pointer-crash") {
          const db = new DatabaseSync(join(f.artifactRoot, "state.sqlite"));
          db.prepare("DELETE FROM operator_records WHERE key=?").run(key);
          db.close();
        }
        f.store = new Store(join(f.artifactRoot, "state.sqlite"));
        f.adapter = new OpencodeAdapter(f.store, f.lease, f.config, {
          sourceEnv: f.sourceEnv,
        });
      }
      const replay = await f.adapter.settleCommand(
        plan,
        prior.commandId,
        undefined,
        true,
      );
      assert.deepEqual(replay, prior.settlement);
      assert.deepEqual(
        settlementToResultEvent(replay, action),
        settlementToResultEvent(prior.settlement, action),
      );
      assert.deepEqual(f.store.operatorRecord(key), prior);
      assert.deepEqual(readFileSync(prior.receipt.path), bytes);
      assert.deepEqual(
        readFileSync(join(plan.paths.parentTmp, "fake-export-record.json")),
        exportRecord,
      );
      assert.deepEqual(
        readFileSync(join(plan.paths.parentTmp, "fake-record.json")),
        nativeRecord,
      );
      assert.equal(f.store.commands(action.runId).length, commandCount);
      assert.deepEqual(
        f.store.coordinatorSnapshot(action.runId),
        settledSnapshot,
      );
      assertAgentObservation(
        f.store,
        f.config,
        plan,
        settlementToResultEvent(replay, action),
      );
    } finally {
      await closeFixture(f);
    }
  });
}

test("host118 replay refuses corrupt, misbound, unknown-physical and C5 drift without replacing retained proof", async () => {
  const f = opencodeFixture("replay-refusals118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchOpencode(
      f,
      action,
      successScript(finalProposal(action, "implementer")),
    );
    await pending;
    const key = "opencode-observation/" + action.key,
      prior = f.store.operatorRecord(key);
    const original = readFileSync(prior.receipt.path),
      exportRecord = readFileSync(
        join(plan.paths.parentTmp, "fake-export-record.json"),
      );
    const unchanged = () => {
      assert.deepEqual(f.store.operatorRecord(key), prior);
      assert.deepEqual(
        readFileSync(join(plan.paths.parentTmp, "fake-export-record.json")),
        exportRecord,
      );
    };
    await assert.rejects(
      () =>
        f.adapter.settleCommand(
          { ...plan, action: { ...plan.action, inputDigest: "bad" } },
          prior.commandId,
          undefined,
          true,
        ),
      /binding/,
    );
    unchanged();
    await assert.rejects(
      () =>
        f.adapter.settleCommand(
          { ...plan, spec: { ...plan.spec, timeoutMs: 1 } },
          prior.commandId,
          undefined,
          true,
        ),
      /binding/,
    );
    unchanged();
    await assert.rejects(
      () => f.adapter.settleCommand(plan, prior.commandId, undefined, false),
      /physical/,
    );
    unchanged();
    const command = f.store.command.bind(f.store);
    f.store.command = (id) => ({ ...command(id), group: null });
    await assert.rejects(
      () => f.adapter.settleCommand(plan, prior.commandId, undefined, true),
      /physical/,
    );
    f.store.command = command;
    unchanged();
    writeFileSync(
      prior.receipt.path,
      Buffer.concat([original, Buffer.from("corrupt")]),
    );
    await assert.rejects(
      () => f.adapter.settleCommand(plan, prior.commandId, undefined, true),
      /metadata|drift/,
    );
    unchanged();
    assert.deepEqual(
      readFileSync(prior.receipt.path),
      Buffer.concat([original, Buffer.from("corrupt")]),
    );
    writeFileSync(prior.receipt.path, original);
    const binary = readFileSync(f.binary.path);
    writeFileSync(
      f.binary.path,
      Buffer.concat([binary, Buffer.from("\n// drift\n")]),
    );
    await assert.rejects(
      () => f.adapter.settleCommand(plan, prior.commandId, undefined, true),
      /binary-identity/,
    );
    unchanged();
    writeFileSync(f.binary.path, binary);
    assert(
      f.store.operatorRecords("opencode-replay-refusal/" + action.key + "/")
        .length >= 3,
    );
    const observerStore = new Store(join(f.artifactRoot, "state.sqlite"));
    try {
      const observer = new OpencodeAdapter(observerStore, f.lease, f.config, {
        sourceEnv: f.sourceEnv,
      });
      const replays = await Promise.all([
        f.adapter.settleCommand(plan, prior.commandId, undefined, true),
        observer.settleCommand(plan, prior.commandId, undefined, true),
      ]);
      assert.deepEqual(replays, [prior.settlement, prior.settlement]);
      // A reopened observer with conflicting evidence cannot replace the genuine winner.
      assert.throws(
        () =>
          observerStore.retainOperatorRecord(key, {
            ...prior,
            settlement: { ...prior.settlement, detail: "conflicting-observer" },
          }),
        /evidence-conflict/,
      );
      assert.deepEqual(observerStore.operatorRecord(key), prior);
      unchanged();
    } finally {
      observerStore.close();
    }
  } finally {
    await closeFixture(f);
  }
});

test("host118 SIGKILL after immutable receipt before projection recovers exact proof without another native child", async () => {
  const evidenceRoot = process.env.OPENCODE_ARTIFACT_ROOT;
  const marker = join(evidenceRoot, "crash-gap-" + Date.now() + ".json");
  mkdirSync(evidenceRoot, { recursive: true });
  const code = `import{opencodeFixture,baselinePass,schedule,dispatchOpencode,finalProposal,successScript}from'./tests/opencode-support.mjs';import{writeFileSync}from'node:fs';const f=opencodeFixture('sigkill-proof-gap118');baselinePass(f);const action=schedule(f,'implement');let plan;const method=typeof f.store.retainOperatorRecord==='function'?'retainOperatorRecord':'saveOperatorRecord';const retain=f.store[method].bind(f.store);f.store[method]=(key,value)=>{if(key==='opencode-observation/'+action.key){writeFileSync(${JSON.stringify(marker)},JSON.stringify({db:f.store.path,lease:f.lease,config:f.config,sourceEnv:f.sourceEnv,plan,observation:value}),{mode:0o600});process.kill(process.pid,'SIGKILL');}return retain(key,value)};const launch=dispatchOpencode(f,action,successScript(finalProposal(action,'implementer')));plan=launch.plan;await launch.pending;throw Error('crash barrier not reached');`;
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: process.cwd(),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          OPENCODE_ARTIFACT_ROOT: evidenceRoot,
        },
        timeout: 15000,
        stdio: "pipe",
      }),
    (error) => error.signal === "SIGKILL",
  );
  const crash = JSON.parse(readFileSync(marker)),
    store = new Store(crash.db);
  try {
    const key = "opencode-observation/" + crash.plan.action.key;
    assert.equal(store.operatorRecord(key), undefined);
    const snapshot = store.coordinatorSnapshot(crash.lease.runId);
    const raw = readFileSync(crash.observation.receipt.path),
      run = readFileSync(join(crash.plan.paths.parentTmp, "fake-record.json")),
      exp = readFileSync(
        join(crash.plan.paths.parentTmp, "fake-export-record.json"),
      );
    const adapter = new OpencodeAdapter(store, crash.lease, crash.config, {
      sourceEnv: crash.sourceEnv,
    });
    const recovered = await adapter.settleCommand(
      crash.plan,
      crash.observation.commandId,
      undefined,
      true,
    );
    assert.deepEqual(recovered, crash.observation.settlement);
    assert.deepEqual(store.operatorRecord(key), crash.observation);
    assertAgentObservation(
      store,
      crash.config,
      crash.plan,
      settlementToResultEvent(recovered, crash.plan.action),
    );
    assert.deepEqual(readFileSync(crash.observation.receipt.path), raw);
    assert.deepEqual(
      readFileSync(join(crash.plan.paths.parentTmp, "fake-record.json")),
      run,
    );
    assert.deepEqual(
      readFileSync(join(crash.plan.paths.parentTmp, "fake-export-record.json")),
      exp,
    );
    assert.deepEqual(store.coordinatorSnapshot(crash.lease.runId), snapshot);
  } finally {
    store.close();
  }
});

import { canonical } from "../dist/store/json.js";
import { reconcileRetainedObservation } from "../dist/agents/opencode/observation.js";
import { reportedHarnessUsage } from "../dist/agents/seam.js";

for (const failedClass of ["fatal", "unresolved"]) {
  test(`host118 missing-projection ${failedClass} receipt refuses coherent semantic forgery`, async (t) => {
    const evidenceRoot = process.env.OPENCODE_ARTIFACT_ROOT;
    mkdirSync(evidenceRoot, { recursive: true });
    const marker = join(
      evidenceRoot,
      `failed-crash-${failedClass}-${Date.now()}.json`,
    );
    // A real subprocess dies after retaining a genuine failed receipt, before the SQLite pointer.
    const fault =
      failedClass === "fatal"
        ? { version: "wrong-version" }
        : { sessionID: "wrong-session" };
    const code = `import{opencodeFixture,baselinePass,schedule,dispatchOpencode,finalProposal,successScript,defaultExportMarker}from'./tests/opencode-support.mjs';import{writeFileSync}from'node:fs';const f=opencodeFixture('failed-sigkill-gap118');baselinePass(f);const action=schedule(f,'implement');let plan;const retain=f.store.retainOperatorRecord.bind(f.store);f.store.retainOperatorRecord=(key,value)=>{if(key==='opencode-observation/'+action.key){writeFileSync(${JSON.stringify(marker)},JSON.stringify({db:f.store.path,lease:f.lease,config:f.config,sourceEnv:f.sourceEnv,plan,observation:value}),{mode:0o600});process.kill(process.pid,'SIGKILL');}return retain(key,value)};const launch=dispatchOpencode(f,action,successScript(finalProposal(action,'implementer')),{exportMarker:p=>defaultExportMarker(p,${JSON.stringify(fault)})});plan=launch.plan;await launch.pending;throw Error('crash barrier not reached');`;
    assert.throws(
      () =>
        execFileSync(process.execPath, ["--input-type=module", "-e", code], {
          cwd: process.cwd(),
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            OPENCODE_ARTIFACT_ROOT: evidenceRoot,
          },
          timeout: 15000,
          stdio: "pipe",
        }),
      (error) => error.signal === "SIGKILL",
    );
    const crash = JSON.parse(readFileSync(marker)),
      store = new Store(crash.db);
    try {
      const key = "opencode-observation/" + crash.plan.action.key;
      assert.equal(store.operatorRecord(key), undefined);
      assert.equal(crash.observation.settlement.classification, failedClass);
      assert.equal(crash.observation.settlement.outcome, "failed");
      assert.equal(crash.observation.settlement.usage.status, "unknown");
      const path = crash.observation.receipt.path,
        original = readFileSync(path);
      const receipt = JSON.parse(original),
        snapshot = store.coordinatorSnapshot(crash.lease.runId);
      const records = store.commands(crash.lease.runId);
      const native = readFileSync(
        join(crash.plan.paths.parentTmp, "fake-record.json"),
      );
      const exported = readFileSync(
        join(crash.plan.paths.parentTmp, "fake-export-record.json"),
      );
      const adapter = new OpencodeAdapter(store, crash.lease, crash.config, {
        sourceEnv: crash.sourceEnv,
      });
      const reported = reportedHarnessUsage(
        "opencode",
        receipt.exportAudit.audit.rawSha256,
        {
          input: 123456,
          cachedInput: null,
          cacheWriteInput: null,
          output: 1234,
          reasoningOutput: null,
        },
      );
      const changes = [
        ...["changed", "complete", "no_code"].map((outcome) => ({
          name: `${failedClass}+${outcome}`,
          mutate: (r) => {
            r.settlement.outcome = outcome;
            r.usage = reported;
          },
        })),
        ...["changed", "complete", "no_code"].map((outcome) => ({
          name: `complete+${outcome}`,
          mutate: (r) => {
            r.settlement.classification = "complete";
            r.settlement.outcome = outcome;
            r.usage = reported;
          },
        })),
        {
          name: "unknown classification",
          mutate: (r) => {
            r.settlement.classification = "invented";
          },
        },
        {
          name: "legacy usage schema",
          mutate: (r) => {
            r.usage = {
              schema: 1,
              status: "known",
              tokens: 0,
              source: {
                kind: "local-no-model",
                reference: "synthetic-local-only",
              },
            };
          },
        },
        {
          name: "wrong usage harness",
          mutate: (r) => {
            r.usage.harness = "another-harness";
          },
        },
        {
          name: "negative fabricated reported usage",
          mutate: (r) => {
            r.usage = reported;
          },
        },
        {
          name: "negative fabricated ambiguous usage",
          mutate: (r) => {
            r.usage = {
              schema: 2,
              status: "ambiguous-zero",
              source: "native-harness-telemetry",
              harness: "opencode",
              receipt: receipt.exportAudit.audit.rawSha256,
            };
          },
        },
      ];
      for (const { name, mutate } of changes)
        await t.test(name, async () => {
          const forged = structuredClone(receipt);
          mutate(forged);
          forged.receiptDigest = digest(
            canonical({ ...forged, receiptDigest: "" }),
          );
          const bytes = Buffer.from(canonical(forged) + "\n");
          writeFileSync(path, bytes);
          try {
            await assert.rejects(() =>
              adapter.settleCommand(
                crash.plan,
                crash.observation.commandId,
                undefined,
                true,
              ),
            );
            assert.equal(store.operatorRecord(key), undefined);
            assert.deepEqual(readFileSync(path), bytes);
            assert.deepEqual(
              store.coordinatorSnapshot(crash.lease.runId),
              snapshot,
            );
            assert.deepEqual(store.commands(crash.lease.runId), records);
            assert.deepEqual(
              readFileSync(
                join(crash.plan.paths.parentTmp, "fake-record.json"),
              ),
              native,
            );
            assert.deepEqual(
              readFileSync(
                join(crash.plan.paths.parentTmp, "fake-export-record.json"),
              ),
              exported,
            );
          } finally {
            // Reset only this owned adversarial fixture between cases, including the rejected-build red run.
            const db = new DatabaseSync(crash.db);
            db.prepare("DELETE FROM operator_records WHERE key=?").run(key);
            db.close();
          }
        });
      writeFileSync(path, original);
      const recovered = await adapter.settleCommand(
        crash.plan,
        crash.observation.commandId,
        undefined,
        true,
      );
      assert.deepEqual(recovered, crash.observation.settlement);
      assert.deepEqual(store.operatorRecord(key), crash.observation);
      assert.deepEqual(readFileSync(path), original);
      assert.deepEqual(store.coordinatorSnapshot(crash.lease.runId), snapshot);
      assert.deepEqual(store.commands(crash.lease.runId), records);
      assert.deepEqual(
        readFileSync(join(crash.plan.paths.parentTmp, "fake-record.json")),
        native,
      );
      assert.deepEqual(
        readFileSync(
          join(crash.plan.paths.parentTmp, "fake-export-record.json"),
        ),
        exported,
      );
    } finally {
      store.close();
    }
  });
}

for (const usageStatus of ["reported", "ambiguous-zero", "unknown"]) {
  test(`host118 authentic failed proposal replays original ${usageStatus} usage after reopen`, async () => {
    const f = opencodeFixture("negative-usage-replay118");
    try {
      baselinePass(f);
      const action = schedule(f, "implement");
      const zero = {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      const { plan, pending } = dispatchOpencode(
        f,
        action,
        successScript(
          finalProposal(action, "implementer", "failed"),
          usageStatus === "ambiguous-zero" ? { tokens: zero } : {},
        ),
        {
          exportMarker: (p) =>
            defaultExportMarker(
              p,
              usageStatus === "ambiguous-zero"
                ? { tokens: zero }
                : usageStatus === "unknown"
                  ? { tokens: { input: 1300 } }
                  : {},
            ),
        },
      );
      await pending;
      const key = "opencode-observation/" + action.key,
        original = f.store.operatorRecord(key);
      assert.equal(original.settlement.classification, "complete");
      assert.equal(original.settlement.outcome, "failed");
      assert.equal(original.settlement.usage.status, usageStatus);
      const bytes = readFileSync(original.receipt.path);
      const native = readFileSync(
        join(plan.paths.parentTmp, "fake-record.json"),
      );
      const exported = readFileSync(
        join(plan.paths.parentTmp, "fake-export-record.json"),
      );
      const snapshot = f.store.coordinatorSnapshot(action.runId),
        commands = f.store.commands(action.runId);
      f.pending = null;
      f.store.close();
      const db = new DatabaseSync(join(f.artifactRoot, "state.sqlite"));
      db.prepare("DELETE FROM operator_records WHERE key=?").run(key);
      db.close();
      f.store = new Store(join(f.artifactRoot, "state.sqlite"));
      f.adapter = new OpencodeAdapter(f.store, f.lease, f.config, {
        sourceEnv: f.sourceEnv,
      });
      // Even a legitimate failed proposal cannot mint invented accounting in the crash gap.
      const forged = JSON.parse(bytes);
      forged.usage = reportedHarnessUsage(
        "opencode",
        forged.exportAudit.audit.rawSha256,
        {
          input: 654321,
          cachedInput: null,
          cacheWriteInput: null,
          output: 321,
          reasoningOutput: null,
        },
      );
      forged.receiptDigest = digest(
        canonical({ ...forged, receiptDigest: "" }),
      );
      const forgedBytes = Buffer.from(canonical(forged) + "\n");
      writeFileSync(original.receipt.path, forgedBytes);
      await assert.rejects(
        () =>
          f.adapter.settleCommand(plan, original.commandId, undefined, true),
        /negative-usage/,
      );
      assert.equal(f.store.operatorRecord(key), undefined);
      assert.deepEqual(readFileSync(original.receipt.path), forgedBytes);
      assert.deepEqual(f.store.coordinatorSnapshot(action.runId), snapshot);
      if (usageStatus !== "unknown") {
        const contradictory = JSON.parse(bytes);
        contradictory.settlement.classification = "unresolved";
        contradictory.settlement.outcome = "interrupted";
        contradictory.receiptDigest = digest(
          canonical({ ...contradictory, receiptDigest: "" }),
        );
        const contradictoryBytes = Buffer.from(canonical(contradictory) + "\n");
        writeFileSync(original.receipt.path, contradictoryBytes);
        await assert.rejects(
          () =>
            f.adapter.settleCommand(plan, original.commandId, undefined, true),
          /negative-usage/,
        );
        assert.equal(f.store.operatorRecord(key), undefined);
        assert.deepEqual(
          readFileSync(original.receipt.path),
          contradictoryBytes,
        );
      }
      writeFileSync(original.receipt.path, bytes);
      const recovered = await f.adapter.settleCommand(
        plan,
        original.commandId,
        undefined,
        true,
      );
      assert.deepEqual(recovered, original.settlement);
      assert.deepEqual(f.store.operatorRecord(key), original);
      assert.deepEqual(readFileSync(original.receipt.path), bytes);
      assert.deepEqual(f.store.commands(action.runId), commands);
      assert.deepEqual(f.store.coordinatorSnapshot(action.runId), snapshot);
      assert.deepEqual(
        readFileSync(join(plan.paths.parentTmp, "fake-record.json")),
        native,
      );
      assert.deepEqual(
        readFileSync(join(plan.paths.parentTmp, "fake-export-record.json")),
        exported,
      );
    } finally {
      await closeFixture(f);
    }
  });
}

test("host118 authentic cancelled native receipt recovers interrupted without export or new accounting", async () => {
  const f = opencodeFixture("interrupted-replay118");
  try {
    baselinePass(f);
    const action = schedule(f, "implement");
    const { plan, pending } = dispatchOpencode(
      f,
      action,
      successScript(finalProposal(action, "implementer"), {
        afterTool: [{ marker: "cancel-replay-ready" }, { sleep: 10000 }],
      }),
    );
    await waitForFile(join(plan.paths.parentTmp, "cancel-replay-ready"));
    f.store.cancel(action.runId);
    await pending;
    const key = "opencode-observation/" + action.key,
      original = f.store.operatorRecord(key);
    assert.equal(original.settlement.classification, "interrupted");
    assert.equal(original.settlement.outcome, "interrupted");
    assert.equal(original.settlement.usage.status, "unknown");
    assert.equal(readReceipt(plan, original.commandId).exportAudit.ran, false);
    const bytes = readFileSync(original.receipt.path),
      commands = f.store.commands(action.runId);
    const snapshot = f.store.coordinatorSnapshot(action.runId);
    f.pending = null;
    f.store.close();
    const db = new DatabaseSync(join(f.artifactRoot, "state.sqlite"));
    db.prepare("DELETE FROM operator_records WHERE key=?").run(key);
    db.close();
    f.store = new Store(join(f.artifactRoot, "state.sqlite"));
    // A cancelled run cannot construct a fresh launch adapter. Terminal recovery is read-only
    // against the reopened durable Store, without reacquiring or renewing the cancelled lease.
    const recovered = reconcileRetainedObservation(
      f.store,
      f.config,
      plan,
      original.commandId,
      true,
    ).settlement;
    assert.deepEqual(recovered, original.settlement);
    assert.deepEqual(f.store.operatorRecord(key), original);
    assert.deepEqual(readFileSync(original.receipt.path), bytes);
    assert.deepEqual(f.store.commands(action.runId), commands);
    assert.deepEqual(f.store.coordinatorSnapshot(action.runId), snapshot);
    assert.equal(
      (await import("node:fs")).existsSync(
        join(plan.paths.parentTmp, "fake-export-record.json"),
      ),
      false,
    );
  } finally {
    await closeFixture(f);
  }
});
