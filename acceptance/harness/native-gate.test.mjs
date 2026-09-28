// Static gate tests only. No native process, app-server or execution permission.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, NATIVE_EVIDENCE, guard, sha, save } from "./common.mjs";
import {
  validateNativeInvocation,
  nativeGatePath,
  consumeOnce,
} from "./native-integration.mjs";

guard();
const root = join(
  ROOT,
  ".qualification/harness-native-64-continuation",
  `gate-tests-${Date.now()}`,
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const events = [];
let counter = 0;
after(() =>
  save(join(root, "results.json"), {
    classification: "static-gate-tests-only",
    nativeExecutions: 0,
    executionAuthorized: false,
    events,
  }),
);
const head = "1".repeat(40);
const context = (lease = 613) => ({
  root: ROOT,
  branch: "rocky-next",
  head,
  expectedHead: head,
  argv: [`--execute-ticket-64-lease-${lease}`, "--source-commit", head],
  dirty: "",
});
function store(failAt) {
  const directory = join(root, `storage-${++counter}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const map = (path) => {
    assert(path === NATIVE_EVIDENCE || path.startsWith(NATIVE_EVIDENCE + "/"));
    return directory + path.slice(NATIVE_EVIDENCE.length);
  };
  const calls = [],
    fds = new Map();
  // These methods perform REAL exclusive writes and fsync, but all paths map
  // into this new static namespace. The launcher never supplies an IO override.
  const io = {
    lstatSync: (path) => fs.lstatSync(map(path)),
    openSync(path, flags, mode) {
      const kind = flags === "wx" ? "file" : "directory";
      calls.push({ operation: "open", kind, path, flags, mode });
      const fd = fs.openSync(map(path), flags, mode);
      fds.set(fd, kind);
      return fd;
    },
    writeFileSync(fd, bytes) {
      calls.push({ operation: "write", kind: fds.get(fd), sha256: sha(bytes) });
      fs.writeFileSync(fd, bytes);
    },
    fsyncSync(fd) {
      const kind = fds.get(fd);
      calls.push({ operation: "fsync", kind });
      if (kind === failAt) throw Error(`injected-${kind}-fsync`);
      fs.fsyncSync(fd);
    },
    closeSync(fd) {
      calls.push({ operation: "close", kind: fds.get(fd) });
      fds.delete(fd);
      fs.closeSync(fd);
    },
  };
  return { directory, map, io, calls, fds };
}
for (const [label, patch] of [
  ["wrong root", { root: "/wrong" }],
  ["wrong branch", { branch: "main" }],
  ["wrong source", { head: "2".repeat(40) }],
  ["missing expected source", { expectedHead: "" }],
  ["dirty source", { dirty: " M probe.mjs" }],
  [
    "unknown lease",
    { argv: ["--execute-ticket-64-lease-614", "--source-commit", head] },
  ],
  ["missing authority", { argv: [] }],
  ["extra argument", { argv: [...context().argv, "--permission-override"] }],
  [
    "wrong source argument",
    { argv: [context().argv[0], "--source-commit", "2".repeat(40)] },
  ],
])
  test(`gate refuses ${label} before storage/dispatch`, () => {
    assert.throws(() => validateNativeInvocation({ ...context(), ...patch }));
    events.push({ label, status: "rejected-before-storage" });
  });
test("distinct prepared identity preserves old flag, path and receipt bytes", () => {
  const old = validateNativeInvocation(context(551)),
    prepared = validateNativeInvocation(context());
  assert.equal(
    nativeGatePath(old),
    join(NATIVE_EVIDENCE, "lease-551-consumed.json"),
  );
  assert.equal(
    nativeGatePath(prepared),
    join(NATIVE_EVIDENCE, "lease-613-consumed.json"),
  );
  assert.equal(prepared.preparationOnly, true);
  assert.equal(prepared.requiresSeparateRootExecutionLease, true);
  assert.equal(prepared.maximumAttempts, 1);
  assert.equal(prepared.totalDeadlineMs, 60000);
  assert.equal(prepared.cleanupReserveMs, 10000);
  assert.equal(prepared.qualification, false);
  assert.equal(prepared.capability, null);
  const oldBytes = fs.readFileSync(nativeGatePath(old));
  assert.equal(
    sha(oldBytes),
    "460b116463ce76d2fba89dfa2d61c02449f481dbb886c33bd5452d04ce9436ec",
  );
  assert.equal(
    fs.existsSync(nativeGatePath(prepared)),
    false,
    "fresh production receipt must remain absent in static preparation",
  );
  events.push({
    label: "prepared-not-execution-authority",
    old,
    prepared,
    legacyReceiptSha256: sha(oldBytes),
  });
});
test("gate filename is derived from the full validated authority", () => {
  const authority = validateNativeInvocation(context());
  for (const patch of [
    { lease: 999 },
    { maximumAttempts: 2 },
    { totalDeadlineMs: 61000 },
    { cleanupReserveMs: 0 },
    { root: "/wrong" },
    { branch: "main" },
    { preparationOnly: false },
    { requiresSeparateRootExecutionLease: false },
    { capability: {} },
    { ticket: 65 },
  ])
    assert.throws(() => nativeGatePath({ ...authority, ...patch }));
});
for (const lease of [551, 613])
  test(`exclusive fsynced gate ${lease} survives source changes and refuses reuse`, () => {
    const s = store(),
      authority = validateNativeInvocation(context(lease)),
      path = nativeGatePath(authority),
      receipt = {
        ...authority,
        sourceInventorySha256: sha("synthetic-source"),
      };
    let dispatches = 0;
    consumeOnce(path, receipt, s.io);
    dispatches++;
    assert.equal(dispatches, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.map(path))), receipt);
    assert.deepEqual(
      s.calls.map((c) => `${c.operation}:${c.kind}`),
      [
        "open:file",
        "write:file",
        "fsync:file",
        "close:file",
        "open:directory",
        "fsync:directory",
        "close:directory",
      ],
    );
    assert.equal(fs.statSync(s.map(path)).mode & 0o777, 0o600);
    assert.equal(s.fds.size, 0);
    for (const sourceCommit of [head, "2".repeat(40)])
      assert.throws(() => {
        consumeOnce(path, { ...receipt, sourceCommit }, s.io);
        dispatches++;
      }, /EEXIST/);
    assert.equal(dispatches, 1);
    events.push({
      label: `exclusive-${lease}`,
      receipt,
      calls: s.calls,
      dispatches,
      physicalPath: s.map(path),
    });
  });
for (const phase of ["file", "directory"])
  test(`${phase} fsync failure prevents dispatch and still consumes the identity`, () => {
    const s = store(phase),
      authority = validateNativeInvocation(context()),
      path = nativeGatePath(authority);
    let dispatches = 0;
    assert.throws(
      () => {
        consumeOnce(path, authority, s.io);
        dispatches++;
      },
      new RegExp(`injected-${phase}-fsync`),
    );
    assert.equal(dispatches, 0);
    assert.equal(s.fds.size, 0);
    assert.throws(() => {
      consumeOnce(path, authority, s.io);
      dispatches++;
    }, /EEXIST/);
    assert.equal(dispatches, 0);
    events.push({
      label: `${phase}-fsync-failed`,
      calls: s.calls,
      dispatches,
      retainedReceiptSha256: sha(fs.readFileSync(s.map(path))),
    });
  });
test("unsafe roots, noncanonical paths and symlink parents stop before exclusive open", () => {
  const s = store(),
    authority = validateNativeInvocation(context());
  for (const path of [
    join(ROOT, "wrong.json"),
    NATIVE_EVIDENCE + "/../unsafe.json",
  ])
    assert.throws(() => consumeOnce(path, authority, s.io));
  fs.symlinkSync(s.directory, join(s.directory, "alias"));
  assert.throws(
    () =>
      consumeOnce(join(NATIVE_EVIDENCE, "alias/gate.json"), authority, s.io),
    /gate-parent-symlink/,
  );
  assert.equal(s.calls.length, 0);
});
test("launcher diff is only gate-path wiring and consumption precedes any launch", () => {
  const base = "b04f83f33b8b7d6c14e8156820ba063a92e1b5ac";
  const original = execFileSync(
    "git",
    ["show", `${base}:acceptance/harness/probe.mjs`],
    { encoding: "utf8" },
  );
  const current = fs.readFileSync(
    join(ROOT, "acceptance/harness/probe.mjs"),
    "utf8",
  );
  assert.equal(
    current,
    original
      .replace("  consumeOnce,\n", "  consumeOnce,\n  nativeGatePath,\n")
      .replace(
        'consumeOnce(join(NATIVE_EVIDENCE, "lease-551-consumed.json"), {',
        "consumeOnce(nativeGatePath(invocationAuthority), {",
      ),
  );
  const consumption = current.indexOf(
    "consumeOnce(nativeGatePath(invocationAuthority), {",
  );
  for (const marker of [
    "server = createServer",
    "app = spawn(",
    "guardian = spawn(",
  ])
    assert(consumption >= 0 && consumption < current.indexOf(marker));
  assert(
    !current.includes("consumeOnce(nativeGatePath(invocationAuthority), {},"),
  );
  events.push({
    label: "exact-launcher-only-wiring",
    base,
    sha256: sha(current),
    consumptionBeforeOwnedLaunches: true,
  });
});
