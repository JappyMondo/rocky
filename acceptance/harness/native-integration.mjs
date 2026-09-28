// Ticket 64: preserve consumed execution identity 551/553. Identity 613 is
// STATIC preparation only; separate root execution authority is still required.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import {
  ROOT,
  NATIVE_EVIDENCE,
  BINARY,
  BINARY_SHA,
  fileSha,
  sha,
} from "./common.mjs";

export function validateNativeInvocation({
  root,
  branch,
  head,
  expectedHead,
  argv,
  dirty,
}) {
  assert.equal(root, ROOT, "wrong-native-root");
  assert.equal(branch, "rocky-next", "wrong-native-branch");
  assert.match(expectedHead, /^[a-f0-9]{40}$/, "missing-source-revision");
  assert.equal(head, expectedHead, "native-source-revision-mismatch");
  assert.equal(dirty, "", "native-source-not-clean");
  const lease =
    argv?.[0] === "--execute-ticket-64-lease-551"
      ? 551
      : argv?.[0] === "--execute-ticket-64-lease-613"
        ? 613
        : null;
  assert(lease, "unknown-native-authority");
  assert.deepEqual(
    argv,
    [`--execute-ticket-64-lease-${lease}`, "--source-commit", expectedHead],
    "wrong-native-authority",
  );
  return {
    ticket: 64,
    lease,
    ...(lease === 551
      ? { clarification: 553 }
      : {
          preparationOnly: true,
          requiresSeparateRootExecutionLease: true,
          cleanupReserveMs: 10000,
        }),
    sourceCommit: head,
    root,
    branch,
    maximumAttempts: 1,
    totalDeadlineMs: 60000,
    qualification: false,
    capability: null,
  };
}

export function nativeGatePath(authority) {
  assert([551, 613].includes(authority?.lease), "unknown-native-gate");
  const expected = validateNativeInvocation({
    root: authority.root,
    branch: authority.branch,
    head: authority.sourceCommit,
    expectedHead: authority.sourceCommit,
    argv: [
      `--execute-ticket-64-lease-${authority.lease}`,
      "--source-commit",
      authority.sourceCommit,
    ],
    dirty: "",
  });
  assert.deepEqual(authority, expected, "native-gate-authority-mismatch");
  return join(NATIVE_EVIDENCE, `lease-${authority.lease}-consumed.json`);
}

// The optional IO adapter is for static tests that map logical native paths to
// owned disposable storage. The launcher uses only the real default IO below.
const gateIO = { lstatSync, openSync, writeFileSync, fsyncSync, closeSync };

export function consumeOnce(path, receipt, io = gateIO) {
  assert.equal(resolve(path), path, "noncanonical-gate-path");
  assert(path.startsWith(NATIVE_EVIDENCE + "/"), "wrong-gate-root");
  let parent = dirname(path);
  while (parent.startsWith(NATIVE_EVIDENCE)) {
    assert(
      io.lstatSync(parent).isDirectory() &&
        !io.lstatSync(parent).isSymbolicLink(),
      "gate-parent-symlink",
    );
    parent = dirname(parent);
  }
  const file = io.openSync(path, "wx", 0o600); // O_EXCL: partial failures consume it too.
  try {
    io.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
    io.fsyncSync(file);
  } finally {
    io.closeSync(file);
  }
  const fd = io.openSync(dirname(path), "r");
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

export function inspectNativeHelpers(codexHome) {
  assert.equal(resolve(codexHome), codexHome, "noncanonical-helper-path");
  const root = join(codexHome, "tmp/arg0");
  assert(
    codexHome.startsWith(NATIVE_EVIDENCE + "/attempt-") &&
      codexHome.endsWith("/runtime/codex-home"),
    "wrong-helper-authority",
  );
  for (const path of [codexHome, join(codexHome, "tmp"), root])
    assert(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      "helper-root-symlink",
    );
  const children = readdirSync(root).sort();
  assert.equal(children.length, 1, "missing-or-ambiguous-helper-session");
  assert.match(
    children[0],
    /^codex-arg0[A-Za-z0-9]+$/,
    "unexpected-helper-session",
  );
  const directory = join(root, children[0]);
  assert(
    lstatSync(directory).isDirectory() &&
      !lstatSync(directory).isSymbolicLink(),
    "helper-session-symlink",
  );
  assert.deepEqual(
    readdirSync(directory).sort(),
    [".lock", "apply_patch", "applypatch", "codex-execve-wrapper"],
    "unexpected-helper-roster",
  );
  const entries = [];
  assert.equal(fileSha(BINARY), BINARY_SHA, "helper-binary-mismatch");
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name),
      st = lstatSync(path);
    if (name === ".lock") {
      assert(
        st.isFile() && !st.isSymbolicLink() && st.size === 0,
        "invalid-helper-lock",
      );
      entries.push({
        path,
        type: "file",
        bytes: st.size,
        sha256: fileSha(path),
      });
    } else {
      assert(st.isSymbolicLink(), "helper-is-not-pinned-alias");
      const target = readlinkSync(path);
      // Inspect target text before following anything; never hash host data from
      // an unexpected generated alias. All Unix aliases point to the pinned CLI.
      assert.equal(target, BINARY, "unaccounted-helper-target");
      assert.equal(
        realpathSync(path),
        realpathSync(BINARY),
        "helper-realpath-mismatch",
      );
      entries.push({ path, type: "symlink", target, targetSha256: BINARY_SHA });
    }
  }
  return {
    root,
    entries,
    wrapper: join(directory, "codex-execve-wrapper"),
    selectionEvidence:
      "Observed unique generated Unix arg0 alias; pinned arg0/src/lib.rs:394-410 assigns this exact alias as main_execve_wrapper_exe. Selection is source-derived, not emitted raw SBPL or intercepted exec telemetry.",
    source:
      "https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/arg0/src/lib.rs",
  };
}

export function requirePositiveControl(exitCode, sourceHash, scratchHash) {
  assert.equal(exitCode, 0, "allowed-native-control-failed");
  // Hashes are independently reread effects, not producer pass flags.
  assert.equal(
    sourceHash,
    sha("allowed-native-control"),
    "allowed-source-effect-missing",
  );
  assert.equal(
    scratchHash,
    sha("allowed-scratch-control"),
    "allowed-scratch-effect-missing",
  );
}
