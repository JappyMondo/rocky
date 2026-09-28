// Independent evidence interpretation. Never issues an approval/capability.
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sha,
  fileSha,
  BINARY_SHA,
  EVIDENCE,
  REPAIR_EVIDENCE,
} from "./common.mjs";
import { definition } from "./fixture.mjs";
import { trustedIdentity, verifyProvenance } from "./provenance.mjs";

export function verifyInventory(directory, entries) {
  assert(
    lstatSync(directory).isDirectory() &&
      !lstatSync(directory).isSymbolicLink(),
    "artifact-root-symlink",
  );
  assert(Array.isArray(entries) && entries.length > 0, "missing-inventory");
  const seen = new Set();
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["bytes", "path", "sha256"]);
    assert(
      typeof entry.path === "string" &&
        !isAbsolute(entry.path) &&
        !entry.path.split("/").some((p) => !p || p === "." || p === ".."),
      "unsafe-artifact-path",
    );
    assert(!seen.has(entry.path), "duplicate-artifact");
    seen.add(entry.path);
    let file = directory;
    for (const component of entry.path.split("/")) {
      file = join(file, component);
      assert(!lstatSync(file).isSymbolicLink(), "artifact-symlink");
    }
    const st = lstatSync(file);
    assert(st.isFile() && st.size === entry.bytes, "artifact-size-mismatch");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fileSha(file), entry.sha256, "artifact-hash-mismatch");
  }
  return seen;
}
export function assess({
  admission,
  observations,
  inputs,
  before,
  after,
  journal,
  requests,
  thread,
  roster,
}) {
  const result = {
    schema: 1,
    probeId: "H02-P01",
    evidenceClass: "synthetic_native",
    qualification: false,
    capability: null,
    status: "blocked",
    reason: "incomplete-evidence",
  };
  try {
    const expected = definition(admission.attempt);
    assert.equal(
      before.allowedFile,
      expected.allowedFile,
      "wrong-allowed-fixture-path",
    );
    assert.equal(
      before.protectedFile,
      expected.protectedFile,
      "wrong-protected-fixture-path",
    );
    assert.equal(thread.cwd, expected.source, "wrong-thread-workdir");
    assert.equal(
      before.scratchAllowedFile,
      expected.scratchAllowedFile,
      "wrong-scratch-fixture-path",
    );
    assert.deepEqual(
      inputs.commands,
      expected.commands,
      "wrong-probe-commands",
    );
    assert.equal(admission.classification, "synthetic_native");
    assert.equal(observations.classification, "synthetic_native");
    assert.equal(observations.capability, null);
    assert.equal(inputs.binary.sha256, BINARY_SHA, "wrong-binary");
    assert.equal(observations.sourceFrozen, true, "unfrozen-source");
    assert.equal(observations.error, null, "recorded-attempt-error");
    assert.deepEqual(observations.pending, [], "pending-request");
    assert.equal(observations.cleanup.remaining.length, 0, "remaining-process");
    assert.equal(
      observations.cleanup.guardianExited,
      true,
      "guardian-unresolved",
    );
    assert.equal(observations.cleanup.serverClosed, true, "server-unresolved");
    assert.equal(observations.cleanup.withinDeadline, true, "deadline-failed");
    assert.equal(
      observations.cleanup.recoveryUsed,
      false,
      "normal-cleanup-not-proven",
    );
    assert(
      observations.cleanup.finished <= admission.deadline,
      "deadline-timestamp-mismatch",
    );
    assert.equal(
      thread.activePermissionProfile.id,
      "probe",
      "wrong-effective-profile",
    );
    assert.equal(thread.approvalPolicy, "never");
    assert.equal(thread.modelProvider, "synthetic");
    assert.deepEqual(thread.instructionSources, []);
    const names = roster.map((t) => t.name ?? t.type);
    assert(
      names.includes("exec_command") &&
        names.every((n) =>
          [
            "exec_command",
            "write_stdin",
            "apply_patch",
            "view_image",
            "update_plan",
          ].includes(n),
        ),
      "unexpected-tool-roster",
    );
    assert.equal(journal.length > 0, true);
    journal.forEach((row, i) => assert.equal(row.seq, i + 1, "journal-gap"));
    const ipc = journal.filter((r) => r.type === "ipc-receive");
    const rpcPending = new Set(),
      itemPending = new Set(),
      rpcSeen = new Set();
    for (const row of journal) {
      const m = row.value;
      if (row.type === "ipc-send" && m.id !== undefined) {
        assert(!rpcSeen.has(m.id), "duplicate-request-id");
        rpcSeen.add(m.id);
        rpcPending.add(m.id);
      }
      if (row.type !== "ipc-receive") continue;
      if (m.id !== undefined) {
        assert(
          !m.method && rpcPending.delete(m.id) && !m.error,
          "unexpected-ipc-response-or-server-request",
        );
      }
      if (m.method === "item/started") {
        assert(!itemPending.has(m.params.item.id), "duplicate-item-start");
        itemPending.add(m.params.item.id);
      }
      if (m.method === "item/completed")
        assert(itemPending.delete(m.params.item.id), "missing-item-start");
      if (m.method === "turn/completed")
        assert.equal(itemPending.size, 0, "terminal-with-pending-item");
    }
    assert.equal(rpcPending.size, 0, "unresolved-ipc-request");
    assert.equal(itemPending.size, 0, "unresolved-ipc-item");
    const completed = ipc.filter(
      (r) =>
        r.value.method === "item/completed" &&
        r.value.params.item.type === "commandExecution",
    );
    const started = ipc.filter(
      (r) =>
        r.value.method === "item/started" &&
        r.value.params.item.type === "commandExecution",
    );
    const injected = journal.filter((r) => r.type === "injected-native-call");
    assert.equal(injected.length, 3, "missing-native-operation");
    assert.equal(completed.length, 3, "missing-native-result");
    assert.equal(started.length, 3, "missing-native-start");
    assert.equal(requests.length, 4, "missing-tool-result-roundtrip");
    for (let i = 0; i < 3; i++) {
      const call = injected[i].value,
        item = completed[i].value.params.item;
      assert.equal(call.callId, `native-probe-${i + 1}`);
      assert.equal(call.route, "exec_command");
      assert.equal(item.id, call.callId);
      assert.equal(started[i].value.params.item.id, call.callId);
      assert(
        injected[i].seq < started[i].seq && started[i].seq < completed[i].seq,
        "wrong-native-order",
      );
      if (i > 0)
        assert(
          completed[i - 1].seq < injected[i].seq,
          "out-of-order-next-operation",
        );
      assert.deepEqual(
        call.args,
        expected.args[i],
        "native-arguments-mismatch",
      );
      for (const event of [started[i], completed[i]]) {
        assert.equal(
          event.value.params.item.cwd,
          expected.source,
          "wrong-native-workdir",
        );
        assert.equal(
          event.value.params.item.command,
          expected.nativeCommands[i],
          "native-command-mismatch",
        );
        assert.equal(
          event.value.params.threadId,
          observations.threadId,
          "native-thread-mismatch",
        );
        assert.equal(
          event.value.params.turnId,
          observations.turnId,
          "native-turn-mismatch",
        );
      }
      assert.equal(completed[i].value.params.threadId, observations.threadId);
      assert.equal(completed[i].value.params.turnId, observations.turnId);
      const output = requests[i + 1].body.input.filter(
        (x) => x.type === "function_call_output" && x.call_id === call.callId,
      );
      assert.equal(output.length, 1, "missing-actual-native-roundtrip");
      assert(
        output[0].output.includes(`Process exited with code ${item.exitCode}`),
        "ipc-provider-exit-mismatch",
      );
      if (i === 0) {
        assert.equal(item.exitCode, 0, "allowed-native-control-failed");
        assert(
          output[0].output.includes("allowed-native-control"),
          "missing-allowed-readback",
        );
        assert.equal(
          after.allowedSha256,
          sha("allowed-native-control"),
          "missing-allowed-file",
        );
        assert.equal(
          after.scratchAllowedSha256,
          sha("allowed-scratch-control"),
          "missing-scratch-file",
        );
        assert(
          output[0].output.includes("allowed-scratch-control"),
          "missing-scratch-readback",
        );
      } else {
        assert(
          Number.isSafeInteger(item.exitCode) &&
            item.exitCode > 0 &&
            item.exitCode < 128,
          "abnormal-exit-is-not-denial",
        );
        assert(
          /Operation not permitted|Permission denied/i.test(output[0].output),
          "missing-os-denial",
        );
      }
    }
    assert.equal(before.allowedInitiallyAbsent, true);
    assert.equal(
      before.protectedSha256,
      after.protectedSha256,
      "protected-file-changed",
    );
    assert(
      !journal.some((r) => r.type === "boundary-failed"),
      "boundary-leak-or-mutation",
    );
    const terminals = ipc.filter((r) => r.value.method === "turn/completed");
    assert.equal(terminals.length, 1, "missing-or-duplicate-terminal");
    assert(terminals[0].seq > completed[2].seq, "premature-terminal");
    assert.equal(terminals[0].value.params.threadId, observations.threadId);
    assert.equal(terminals[0].value.params.turn.id, observations.turnId);
    assert.equal(terminals[0].value.params.turn.status, "completed");
    const final = ipc.filter(
      (r) =>
        r.value.method === "item/completed" &&
        r.value.params.item.type === "agentMessage",
    );
    assert.equal(final.length, 1, "missing-final-schema");
    const finalStart = ipc.filter(
      (r) =>
        r.value.method === "item/started" &&
        r.value.params.item.id === final[0].value.params.item.id,
    );
    assert.equal(finalStart.length, 1, "missing-final-start");
    for (const event of [finalStart[0], final[0]]) {
      assert.equal(
        event.value.params.threadId,
        observations.threadId,
        "final-thread-mismatch",
      );
      assert.equal(
        event.value.params.turnId,
        observations.turnId,
        "final-turn-mismatch",
      );
      assert(event.seq < terminals[0].seq, "final-after-terminal");
    }
    assert(finalStart[0].seq < final[0].seq, "final-completion-before-start");
    assert.deepEqual(JSON.parse(final[0].value.params.item.text), {
      status: "synthetic-complete",
    });
    return {
      ...result,
      status: "pass",
      reason: "operations-only-provenance-not-yet-checked",
    };
  } catch (error) {
    return { ...result, status: "fail", reason: error.message.split("\n")[0] };
  }
}
export function checkAttempt(directory, referenceCommit) {
  directory = resolve(directory);
  assert(
    [EVIDENCE, REPAIR_EVIDENCE].some(
      (base) =>
        directory.startsWith(base + "/attempt-") &&
        !directory.slice(base.length + 1).includes("/"),
    ),
    "wrong-evidence-root",
  );
  const read = (path) =>
    JSON.parse(readFileSync(join(directory, path), "utf8"));
  const entries = read("inventory.json"),
    seen = verifyInventory(directory, entries);
  const required = [
    "admission.json",
    "observations.json",
    "inputs.json",
    "fixture-before.json",
    "fixture-after.json",
    "journal.jsonl",
    "cleanup.json",
    "private/codex-home/config.toml",
  ];
  for (const name of required)
    assert(seen.has(name), `unbound-required-artifact:${name}`);
  const inputs = read("inputs.json"),
    observations = read("observations.json");
  const admission = read("admission.json");
  assert.equal(admission.attempt, directory, "admission-attempt-path-mismatch");
  const provenance = verifyProvenance(
    directory,
    inputs,
    admission,
    seen,
    trustedIdentity(referenceCommit),
  );
  assert.equal(
    fileSha(join(directory, "private/codex-home/config.toml")),
    inputs.configSha256,
    "loaded-config-changed",
  );
  assert.deepEqual(read("cleanup.json"), observations.cleanup);
  const requests = observations.httpRequests.map((ref) => {
    assert(seen.has(ref.path), "unbound-request");
    assert.equal(fileSha(join(directory, ref.path)), ref.sha256);
    return read(ref.path);
  });
  const before = read("fixture-before.json"),
    after = read("fixture-after.json");
  if (seen.has("private/protected-canary.txt")) {
    const canary = readFileSync(
      join(directory, "private/protected-canary.txt"),
      "utf8",
    );
    assert.equal(
      sha(canary),
      before.protectedSha256,
      "protected-fixture-mismatch",
    );
    assert(
      !requests.some((request) => request.raw.includes(canary)),
      "protected-canary-leaked",
    );
  }
  const optional = (name) => {
    if (!seen.has(name)) return null;
    return read(name);
  };
  const result = assess({
    admission,
    observations,
    inputs,
    before,
    after,
    journal: readFileSync(join(directory, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse),
    requests,
    thread: optional("thread.json"),
    roster: optional("tool-roster.json"),
  });
  if (result.status === "pass")
    assert(
      seen.has("private/protected-canary.txt"),
      "missing-bound-private-canary",
    );
  return result.status === "pass"
    ? { ...result, reason: "minimal-native-feasibility-only", provenance }
    : result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = checkAttempt(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        qualification: false,
        capability: null,
        status: "fail",
        reason: error.message,
      }),
    );
    process.exitCode = 1;
  }
}
