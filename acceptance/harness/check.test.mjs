import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assess, verifyInventory } from "./check.mjs";
import { ROOT, REPAIR_EVIDENCE, BINARY_SHA, sha, guard } from "./common.mjs";
import { definition } from "./fixture.mjs";
import { prepareSyntheticRepository } from "./fixture.mjs";
import { verifyProvenance } from "./provenance.mjs";
import { inventory } from "./common.mjs";
import { candidatePolicy, excludedPlatformRoots } from "./policy.mjs";

const TEST_EVIDENCE = join(
  ROOT,
  ".qualification/harness-contract-59-identity-repair",
);

// Generated unit fixtures test interpretation only; never native evidence.
function fixture() {
  const attempt = join(REPAIR_EVIDENCE, "attempt-unit");
  const recipe = definition(attempt);
  const f = {
    admission: { classification: "synthetic_native", deadline: 100, attempt },
    observations: {
      classification: "synthetic_native",
      capability: null,
      sourceFrozen: true,
      error: null,
      pending: [],
      threadId: "thread",
      turnId: "turn",
      cleanup: {
        remaining: [],
        guardianExited: true,
        serverClosed: true,
        withinDeadline: true,
        recoveryUsed: false,
        finished: 99,
      },
    },
    inputs: {
      binary: { sha256: BINARY_SHA },
      commands: recipe.commands,
    },
    before: {
      allowedInitiallyAbsent: true,
      protectedSha256: sha("fake"),
      allowedFile: recipe.allowedFile,
      protectedFile: recipe.protectedFile,
      scratchAllowedFile: recipe.scratchAllowedFile,
    },
    after: {
      allowedSha256: sha("allowed-native-control"),
      protectedSha256: sha("fake"),
      scratchAllowedSha256: sha("allowed-scratch-control"),
    },
    thread: {
      thread: {
        id: "thread",
        sessionId: "thread",
        cliVersion: "0.157.1",
        createdAt: 1790558647,
        updatedAt: 1790558647,
        cwd: recipe.source,
        ephemeral: true,
        modelProvider: "synthetic",
        preview: "",
        projectId: null,
        source: "vscode",
        status: { type: "idle" },
        turns: [],
      },
      model: "gpt-5.4",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [join(attempt, "scratch")],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      activePermissionProfile: { id: "probe" },
      approvalPolicy: "never",
      modelProvider: "synthetic",
      instructionSources: [],
      cwd: recipe.source,
    },
    roster: [{ name: "exec_command" }],
    journal: [],
    requests: [{ body: { input: [] } }],
  };
  const row = (type, value) =>
    f.journal.push({ seq: f.journal.length + 1, type, value });
  row("ipc-send", {
    id: "thread-request",
    method: "thread/start",
    params: { cwd: recipe.source },
  });
  row("ipc-receive", {
    id: "thread-request",
    result: structuredClone(f.thread),
  });
  row("ipc-send", {
    id: "turn-request",
    method: "turn/start",
    params: {
      threadId: "thread",
      input: [
        { type: "text", text: "Run the bounded synthetic native probe." },
      ],
    },
  });
  row("ipc-receive", {
    id: "turn-request",
    result: {
      turn: { id: "turn", items: [], status: "inProgress", error: null },
    },
  });
  for (let i = 0; i < 3; i++) {
    const id = `native-probe-${i + 1}`,
      exitCode = i ? 1 : 0;
    const item = {
      id,
      type: "commandExecution",
      cwd: f.thread.cwd,
      command: recipe.nativeCommands[i],
      exitCode,
    };
    row("injected-native-call", {
      callId: id,
      route: "exec_command",
      args: recipe.args[i],
    });
    row("ipc-receive", {
      method: "item/started",
      params: { threadId: "thread", turnId: "turn", item },
    });
    row("ipc-receive", {
      method: "item/completed",
      params: { threadId: "thread", turnId: "turn", item },
    });
    f.requests.push({
      body: {
        input: [
          {
            type: "function_call_output",
            call_id: id,
            output: `Process exited with code ${exitCode}\n${i ? "Operation not permitted" : "allowed-native-controlallowed-scratch-control"}`,
          },
        ],
      },
    });
  }
  const item = {
    id: "final",
    type: "agentMessage",
    text: '{"status":"synthetic-complete"}',
  };
  row("ipc-receive", {
    method: "item/started",
    params: { item, threadId: "thread", turnId: "turn" },
  });
  row("ipc-receive", {
    method: "item/completed",
    params: { item, threadId: "thread", turnId: "turn" },
  });
  row("ipc-receive", {
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: { id: "turn", status: "completed", items: [], error: null },
    },
  });
  return f;
}
function completed(f, n = 0) {
  return f.journal.filter(
    (x) =>
      x.value.method === "item/completed" &&
      x.value.params.item.type === "commandExecution",
  )[n].value.params.item;
}
test("consistent unit fixture establishes operations only, never provenance or capability", () => {
  const r = assess(fixture());
  assert.equal(r.status, "pass");
  assert.equal(r.qualification, false);
  assert.equal(r.capability, null);
});

// Retain unchanged rejected checker from Git for genuine old-pass/new-reject
// demonstrations. This never imports or executes the old native driver.
guard();
const legacyDir = join(TEST_EVIDENCE, "legacy");
mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
for (const name of ["check.mjs", "common.mjs"]) {
  const bytes = execFileSync("git", [
    "show",
    `c13930b462fd5abcaa24f279d03565757e6b7e39:acceptance/harness/${name}`,
  ]);
  const path = join(legacyDir, name);
  if (!existsSync(path))
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  assert.equal(sha(readFileSync(path)), sha(bytes));
}
const legacy = await import(pathToFileURL(join(legacyDir, "check.mjs")));
const rejectedCommit = "d3d126a94a5dfc074ae31e3c5ab86e4629022b2f";
const rejectedDir = join(TEST_EVIDENCE, "legacy-d3d126a");
mkdirSync(rejectedDir, { recursive: true, mode: 0o700 });
for (const name of [
  "check.mjs",
  "common.mjs",
  "fixture.mjs",
  "provenance.mjs",
]) {
  const bytes = execFileSync("git", [
    "show",
    `${rejectedCommit}:acceptance/harness/${name}`,
  ]);
  const path = join(rejectedDir, name);
  if (!existsSync(path))
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  assert.equal(sha(readFileSync(path)), sha(bytes));
}
const rejected = await import(pathToFileURL(join(rejectedDir, "check.mjs")));
const identityResults = [],
  identityResultsPath = join(
    TEST_EVIDENCE,
    `identity-regressions-${Date.now()}.json`,
  );
const resequence = (f) => f.journal.forEach((r, i) => (r.seq = i + 1));
const startPair = (f, method) => {
  const request = f.journal.find(
    (r) => r.type === "ipc-send" && r.value.method === method,
  );
  return {
    request,
    response: f.journal.find(
      (r) => r.type === "ipc-receive" && r.value.id === request.value.id,
    ),
  };
};
const invocationCases = [];
for (const [label, value] of [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
  ["blank", "  "],
  ["array", []],
  ["object", {}],
  ["number", 5],
]) {
  invocationCases.push([
    `globally ${label} invocation IDs`,
    (f) => {
      const set = (obj, key) =>
        value === undefined ? delete obj[key] : (obj[key] = value);
      set(f.observations, "threadId");
      set(f.observations, "turnId");
      set(f.thread.thread, "id");
      set(startPair(f, "thread/start").response.value.result.thread, "id");
      set(startPair(f, "turn/start").request.value.params, "threadId");
      set(startPair(f, "turn/start").response.value.result.turn, "id");
      for (const row of f.journal.filter(
        (r) => r.type === "ipc-receive" && r.value.method,
      )) {
        const p = row.value.params;
        set(p, "threadId");
        if (p.item) set(p, "turnId");
        if (p.turn) set(p.turn, "id");
      }
    },
  ]);
}
for (const [label, value] of [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
  ["object", {}],
  ["fraction", 1.5],
  ["boolean", false],
]) {
  invocationCases.push([
    `invalid ${label} RPC correlation ID`,
    (f) => {
      const pair = startPair(f, "thread/start");
      for (const row of [pair.request, pair.response]) {
        if (value === undefined) delete row.value.id;
        else row.value.id = value;
      }
    },
  ]);
}
invocationCases.push(
  [
    "empty thread/start response",
    (f) => {
      startPair(f, "thread/start").response.value.result = {};
    },
  ],
  [
    "empty turn/start response",
    (f) => {
      startPair(f, "turn/start").response.value.result = {};
    },
  ],
  [
    "conflicting authoritative thread ID",
    (f) => {
      startPair(f, "thread/start").response.value.result.thread.id =
        "other-thread";
    },
  ],
  [
    "conflicting authoritative turn ID",
    (f) => {
      startPair(f, "turn/start").response.value.result.turn.id = "other-turn";
    },
  ],
  [
    "turn request targets another thread",
    (f) => {
      startPair(f, "turn/start").request.value.params.threadId = "other-thread";
    },
  ],
  [
    "missing thread/start chain",
    (f) => {
      f.journal.splice(0, 2);
      resequence(f);
    },
  ],
  [
    "missing turn/start chain",
    (f) => {
      f.journal.splice(2, 2);
      resequence(f);
    },
  ],
  [
    "duplicate thread/start chain with unique RPC ID",
    (f) => {
      const rows = structuredClone(f.journal.slice(0, 2));
      rows.forEach((r) => (r.value.id = "second-thread-request"));
      f.journal.splice(2, 0, ...rows);
      resequence(f);
    },
  ],
  [
    "duplicate turn/start chain with unique RPC ID",
    (f) => {
      const rows = structuredClone(f.journal.slice(2, 4));
      rows.forEach((r) => (r.value.id = "second-turn-request"));
      f.journal.splice(4, 0, ...rows);
      resequence(f);
    },
  ],
  [
    "missing required thread response field",
    (f) => {
      delete startPair(f, "thread/start").response.value.result.thread
        .sessionId;
    },
  ],
  [
    "malformed turn items array",
    (f) => {
      startPair(f, "turn/start").response.value.result.turn.items = {};
    },
  ],
  [
    "malformed turn request input",
    (f) => {
      startPair(f, "turn/start").request.value.params.input = null;
    },
  ],
  [
    "malformed start response status",
    (f) => {
      startPair(f, "turn/start").response.value.result.turn.status = "made-up";
    },
  ],
  [
    "RPC response also claims error null",
    (f) => {
      startPair(f, "thread/start").response.value.error = null;
    },
  ],
  [
    "missing final item ID",
    (f) => {
      for (const r of f.journal.filter(
        (r) => r.value.params?.item?.type === "agentMessage",
      ))
        delete r.value.params.item.id;
    },
  ],
);
for (const [name, mutate] of invocationCases)
  test(`SPEC03 invocation regression: ${name}`, () => {
    const f = fixture();
    mutate(f);
    // Actual retained evidence is JSON, so repeated object values cannot borrow
    // JavaScript reference equality across independent fields/frames.
    const wire = JSON.parse(JSON.stringify(f));
    const oldResult = rejected.assess(wire),
      newResult = assess(wire);
    identityResults.push({
      name,
      evidenceClass: "evaluator_selftest",
      legacyCommit: rejectedCommit,
      serializedEvidence: true,
      oldResult,
      newResult,
    });
    writeFileSync(
      identityResultsPath,
      JSON.stringify(identityResults, null, 2) + "\n",
      { mode: 0o600 },
    );
    assert.equal(
      oldResult.status,
      [
        "globally array invocation IDs",
        "globally object invocation IDs",
        "invalid object RPC correlation ID",
      ].includes(name)
        ? "fail"
        : "pass",
      `unexpected legacy result: ${oldResult.reason}`,
    );
    assert.equal(newResult.status, "fail");
    assert.equal(newResult.capability, null);
  });
for (const [name, mutate] of [
  [
    "duplicate response",
    (f) => {
      f.journal.splice(2, 0, structuredClone(f.journal[1]));
      resequence(f);
    },
  ],
  [
    "missing response",
    (f) => {
      f.journal.splice(1, 1);
      resequence(f);
    },
  ],
  [
    "wrong response ID",
    (f) => {
      f.journal[1].value.id = "unknown";
    },
  ],
  [
    "duplicate request ID",
    (f) => {
      f.journal[2].value.id = f.journal[0].value.id;
    },
  ],
])
  test(`complete correlation chain rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(rejected.assess(f).status, "fail");
    assert.equal(assess(f).status, "fail");
  });
test("valid integer RPC IDs and actual-shaped startup responses remain accepted", () => {
  const f = fixture();
  for (const [index, method] of ["thread/start", "turn/start"].entries()) {
    const pair = startPair(f, method);
    pair.request.value.id = index;
    pair.response.value.id = index;
  }
  assert.equal(assess(f).status, "pass");
});
const regressionPath = join(TEST_EVIDENCE, `regressions-${Date.now()}.json`);
const regressionResults = [];
function retainedRegression(name, oldResult, newResult) {
  regressionResults.push({
    name,
    evidenceClass: "evaluator_selftest",
    legacyCommit: "c13930b462fd5abcaa24f279d03565757e6b7e39",
    oldResult,
    newResult,
  });
  writeFileSync(
    regressionPath,
    JSON.stringify(regressionResults, null, 2) + "\n",
    { mode: 0o600 },
  );
}
function replaceOperation(f, i, cmd) {
  f.inputs.commands[i] = cmd;
  f.journal.filter((r) => r.type === "injected-native-call")[i].value.args.cmd =
    cmd;
  completed(f, i).command = `/bin/sh -c "${cmd}"`;
}
const reviewCases = [
  [
    "SPEC01 wrong protected path with genuine-looking denied native result",
    (f) => replaceOperation(f, 1, "/bin/cat '/different-protected-path'"),
  ],
  [
    "SPEC01 printed permission denial is no protected operation",
    (f) => replaceOperation(f, 2, "printf 'Permission denied'; exit 1"),
  ],
  [
    "SPEC01 substituted allowed operation",
    (f) => replaceOperation(f, 0, "printf allowed-native-control"),
  ],
  [
    "SPEC01 same command different shell",
    (f) => {
      f.journal.find(
        (r) => r.type === "injected-native-call",
      ).value.args.shell = "/bin/zsh";
    },
  ],
  [
    "SPEC01 same command different dispatch cwd",
    (f) => {
      f.journal.find(
        (r) => r.type === "injected-native-call",
      ).value.args.workdir = "/different";
    },
  ],
  [
    "SPEC01 different designated canary despite unchanged hash",
    (f) => {
      f.before.protectedFile = f.before.protectedFile + ".other";
    },
  ],
  [
    "SPEC03 final message from wrong turn",
    (f) => {
      for (const row of f.journal.filter(
        (r) => r.value.params?.item?.type === "agentMessage",
      ))
        row.value.params.turnId = "wrong-turn";
    },
  ],
  [
    "SPEC03 final message from wrong thread",
    (f) => {
      for (const row of f.journal.filter(
        (r) => r.value.params?.item?.type === "agentMessage",
      ))
        row.value.params.threadId = "wrong-thread";
    },
  ],
  [
    "SPEC03 missing final invocation IDs",
    (f) => {
      for (const row of f.journal.filter(
        (r) => r.value.params?.item?.type === "agentMessage",
      )) {
        delete row.value.params.threadId;
        delete row.value.params.turnId;
      }
    },
  ],
  [
    "SPEC03 complete final message after terminal",
    (f) => {
      const finalRows = f.journal.splice(-3, 2);
      f.journal.push(...finalRows);
      f.journal.forEach((r, i) => (r.seq = i + 1));
    },
  ],
];
for (const [name, mutate] of reviewCases)
  test(name, () => {
    const f = fixture();
    mutate(f);
    const oldResult = legacy.assess(f),
      newResult = assess(f);
    retainedRegression(name, oldResult, newResult);
    assert.equal(
      oldResult.status,
      "pass",
      "unchanged rejected checker must reproduce false pass",
    );
    assert.equal(newResult.status, "fail");
  });

function provenanceFixture() {
  const directory = join(
    TEST_EVIDENCE,
    `provenance-unit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(directory, "loaded-source"), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, "loaded-schema"));
  writeFileSync(
    join(directory, "loaded-schema/type.json"),
    '{"type":"object"}\n',
  );
  const schema = inventory(join(directory, "loaded-schema"));
  const manifest = {
    contractId: "UNIT-FIXTURE-NOT-NATIVE",
    protocolSchema: { inventorySha256: sha(JSON.stringify(schema)) },
  };
  writeFileSync(
    join(directory, "loaded-source/manifest.json"),
    JSON.stringify(manifest),
  );
  writeFileSync(
    join(directory, "loaded-source/probe.mjs"),
    "// synthetic selftest bytes\n",
  );
  const source = inventory(join(directory, "loaded-source"));
  const reference = {
    commit: "0".repeat(40),
    source,
    schemaCount: schema.length,
    contract: {
      id: manifest.contractId,
      sha256: sha(readFileSync(join(directory, "loaded-source/manifest.json"))),
      sourceInventorySha256: sha(JSON.stringify(source)),
      schemaInventorySha256: sha(JSON.stringify(schema)),
    },
  };
  const f = fixture();
  Object.assign(f.inputs, {
    sourceHead: reference.commit,
    sourceFiles: structuredClone(source),
    schema: structuredClone(schema),
    contract: structuredClone(reference.contract),
  });
  Object.assign(f.admission, {
    head: reference.commit,
    contract: structuredClone(reference.contract),
  });
  return {
    directory,
    reference,
    f,
    seen: verifyInventory(directory, inventory(directory)),
  };
}
const provenanceCases = [
  [
    "SPEC02 missing source identity",
    (x) => {
      delete x.f.inputs.sourceFiles;
    },
  ],
  [
    "SPEC02 missing schema identity",
    (x) => {
      delete x.f.inputs.schema;
    },
  ],
  [
    "SPEC02 changed source revision",
    (x) => {
      x.f.inputs.sourceHead = "1".repeat(40);
    },
  ],
  [
    "SPEC02 changed contract identity",
    (x) => {
      x.f.inputs.contract.sha256 = sha("other");
    },
  ],
  [
    "SPEC02 missing admission contract",
    (x) => {
      delete x.f.admission.contract;
    },
  ],
  [
    "SPEC02 missing retained source even with sourceFrozen true",
    (x) => {
      x.seen.delete("loaded-source/probe.mjs");
    },
  ],
  [
    "SPEC02 missing retained schema",
    (x) => {
      x.seen.delete("loaded-schema/type.json");
    },
  ],
  [
    "SPEC02 altered source bytes with fresh evidence inventory",
    (x) => {
      writeFileSync(
        join(x.directory, "loaded-source/probe.mjs"),
        "// tampered\n",
      );
      x.seen = verifyInventory(x.directory, inventory(x.directory));
    },
  ],
  [
    "SPEC02 altered schema bytes with fresh evidence inventory",
    (x) => {
      writeFileSync(
        join(x.directory, "loaded-schema/type.json"),
        '{"type":"string"}\n',
      );
      x.seen = verifyInventory(x.directory, inventory(x.directory));
    },
  ],
  [
    "SPEC02 changed source bytes and claimed identity",
    (x) => {
      writeFileSync(
        join(x.directory, "loaded-source/probe.mjs"),
        "// tampered\n",
      );
      x.f.inputs.sourceFiles = inventory(join(x.directory, "loaded-source"));
      x.seen = verifyInventory(x.directory, inventory(x.directory));
    },
  ],
  [
    "SPEC02 extra unlisted loaded source",
    (x) => {
      writeFileSync(join(x.directory, "loaded-source/hidden.mjs"), "// extra");
    },
  ],
  [
    "SPEC02 extra unlisted schema",
    (x) => {
      writeFileSync(join(x.directory, "loaded-schema/extra.json"), "{}");
    },
  ],
];
test("complete retained selftest source/schema bytes verify against separate trusted reference", () => {
  const x = provenanceFixture();
  verifyProvenance(x.directory, x.f.inputs, x.f.admission, x.seen, x.reference);
});
for (const [name, mutate] of provenanceCases)
  test(name, () => {
    const x = provenanceFixture();
    mutate(x);
    const oldResult = legacy.assess(x.f);
    let error;
    try {
      verifyProvenance(
        x.directory,
        x.f.inputs,
        x.f.admission,
        x.seen,
        x.reference,
      );
    } catch (e) {
      error = e;
    }
    retainedRegression(name, oldResult, {
      status: error ? "fail" : "pass",
      reason: error?.message,
    });
    assert.equal(oldResult.status, "pass");
    assert(error, "new checker provenance boundary must reject");
  });
test("synthetic Git metadata resolves only to owned source without parent history or remotes", () => {
  const source = join(TEST_EVIDENCE, `git-unit-${Date.now()}`, "source");
  const result = prepareSyntheticRepository(source);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: source,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CEILING_DIRECTORIES: join(source, ".."),
  };
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: source,
      env,
      encoding: "utf8",
    }).trim();
  assert.equal(git("rev-parse", "--show-toplevel"), source);
  assert.equal(
    resolve(source, git("rev-parse", "--git-common-dir")),
    join(source, ".git"),
  );
  assert.equal(git("rev-parse", "--absolute-git-dir"), join(source, ".git"));
  assert.equal(git("rev-parse", "HEAD"), result.commit);
  assert.equal(git("branch", "--show-current"), "rocky-next");
  assert.equal(git("remote"), "");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert(
    !readFileSync(join(source, ".git/config"), "utf8").includes("worktree"),
  );
});
test("conservative candidate includes every reviewed exact/final deny and separate helper authority", () => {
  const attempt = join(REPAIR_EVIDENCE, "attempt-policy-unit"),
    policy = candidatePolicy(attempt);
  assert.equal(policy.filesystem[":minimal"], "read");
  for (const root of excludedPlatformRoots) {
    assert.equal(policy.filesystem[root], "deny");
    assert.equal(policy.filesystem[`${root}{,/**}`], "deny");
  }
  assert.equal(policy.filesystem[join(attempt, "source/.git")], "read");
  assert.equal(policy.filesystem[join(attempt, "private") + "{,/**}"], "deny");
  assert.equal(policy.environment.HOME, join(attempt, "scratch/home"));
  assert.equal(policy.environment.TMPDIR, join(attempt, "scratch/tmp"));
  assert.equal(
    policy.environment.CODEX_HOME,
    join(attempt, "runtime/codex-home"),
  );
  assert(
    !policy.helperBoundary.permittedAutomaticSubtree.startsWith(
      join(attempt, "private"),
    ),
  );
  assert.equal(
    policy.filesystem[join(attempt, "runtime") + "{,/**}"],
    undefined,
  );
  assert.equal(policy.filesystem["/"], undefined);
  assert.equal(policy.filesystem["/Users"], undefined);
  assert(policy.runtimeSharedTempDenial.includes("UNPROVEN"));
});
const negatives = [
  [
    "completed turn and unchanged canary do not hide actual native134",
    (f) => {
      completed(f).exitCode = 134;
      f.requests[1].body.input[0].output =
        "Process exited with code 134\nOutput:\n";
      f.after.allowedSha256 = null;
    },
    "allowed-native-control-failed",
  ],
  [
    "denial by native signal is not containment",
    (f) => {
      completed(f, 1).exitCode = 134;
      f.requests[2].body.input[0].output =
        "Process exited with code 134\nOperation not permitted";
    },
    "abnormal-exit-is-not-denial",
  ],
  [
    "permission-like prose with exit0 is not denial",
    (f) => {
      completed(f, 1).exitCode = 0;
      f.requests[2].body.input[0].output =
        "Process exited with code 0\nPermission denied";
    },
    "abnormal-exit-is-not-denial",
  ],
  [
    "missing real output roundtrip",
    (f) => {
      f.requests[2].body.input = [];
    },
    "missing-actual-native-roundtrip",
  ],
  [
    "claimed pass without journal",
    (f) => {
      f.observations.passed = true;
      f.journal = [];
    },
    null,
  ],
  [
    "missing terminal",
    (f) => {
      f.journal.pop();
    },
    "missing-or-duplicate-terminal",
  ],
  [
    "truncated journal sequence",
    (f) => {
      f.journal[3].seq++;
    },
    "journal-gap",
  ],
  [
    "missing native dispatch",
    (f) => {
      f.journal.find((x) => x.type === "injected-native-call").type = "other";
    },
    "missing-native-operation",
  ],
  [
    "pending IPC hidden by claimed empty observation",
    (f) => {
      f.journal[0].value.id = 99;
    },
    "uncorrelated-or-duplicate-response",
  ],
  [
    "unfinished tool item before terminal",
    (f) => {
      f.journal.splice(-1, 0, {
        type: "ipc-receive",
        value: {
          method: "item/started",
          params: {
            threadId: "thread",
            turnId: "turn",
            item: { id: "unfinished", type: "agentMessage" },
          },
        },
      });
      f.journal.forEach((r, i) => (r.seq = i + 1));
    },
    "terminal-with-pending-item",
  ],
  [
    "mismatched native thread",
    (f) => {
      f.journal.find(
        (x) => x.value.method === "item/completed",
      ).value.params.threadId = "other";
    },
    null,
  ],
  [
    "changed protected artifact",
    (f) => {
      f.after.protectedSha256 = sha("changed");
    },
    "protected-file-changed",
  ],
  [
    "no allowed file",
    (f) => {
      f.after.allowedSha256 = null;
    },
    "missing-allowed-file",
  ],
  [
    "guardian recovery is distinct from normal cleanup",
    (f) => {
      f.observations.cleanup.recoveryUsed = true;
    },
    "normal-cleanup-not-proven",
  ],
  [
    "pending owned child",
    (f) => {
      f.observations.cleanup.remaining = [{ pid: 42 }];
    },
    "remaining-process",
  ],
  [
    "late cleanup cannot pass claimed deadline flag",
    (f) => {
      f.observations.cleanup.finished = 101;
    },
    "deadline-timestamp-mismatch",
  ],
  [
    "wrong binary",
    (f) => {
      f.inputs.binary.sha256 = sha("other");
    },
    "wrong-binary",
  ],
  [
    "fake upstream cannot mint live capability",
    (f) => {
      f.observations.classification = "live_provider";
      f.observations.capability = "fake";
    },
    null,
  ],
];
for (const [name, mutate, reason] of negatives)
  test(name, () => {
    const f = fixture();
    mutate(f);
    const r = assess(f);
    assert.equal(r.status, "fail");
    if (reason) assert(r.reason.includes(reason), r.reason);
    assert.equal(r.capability, null);
  });
test("inventory rejects forged/missing/duplicate/path-escaping/symlink evidence", () => {
  guard();
  const dir = join(TEST_EVIDENCE, `selftest-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "artifact"), "original", { mode: 0o600 });
  const entry = { path: "artifact", bytes: 8, sha256: sha("original") };
  verifyInventory(dir, [entry]);
  assert.throws(() => verifyInventory(dir, [entry, entry]), /duplicate/);
  assert.throws(
    () => verifyInventory(dir, [{ ...entry, path: "../artifact" }]),
    /unsafe/,
  );
  assert.throws(() => verifyInventory(dir, [{ ...entry, bytes: 9 }]), /size/);
  writeFileSync(join(dir, "artifact"), "modified");
  assert.throws(() => verifyInventory(dir, [entry]), /hash/);
  symlinkSync("artifact", join(dir, "link"));
  assert.throws(
    () => verifyInventory(dir, [{ ...entry, path: "link" }]),
    /symlink/,
  );
});
