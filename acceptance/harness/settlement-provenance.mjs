import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINARY, BINARY_SHA, sha, inventory } from "./common.mjs";
import { definition } from "./fixture.mjs";
import { candidatePolicy } from "./policy.mjs";
import { nativeConfig } from "./native-config.mjs";
import { DENIAL_VARIANT } from "./settlement.mjs";

// Production uses the admitted directory for both authority and byte reads.
// The final argument is an internal static-test relocation seam, never bundle input.
export function verifySettlementProvenance(
  directory,
  inputs,
  seen,
  reference,
  journal,
  requests,
  before,
  after,
  attempt = directory,
) {
  const spec = reference.observationVariant;
  assert.equal(spec?.id, DENIAL_VARIANT, "unapproved-observation-variant");
  assert.equal(
    inputs.observationVariant,
    DENIAL_VARIANT,
    "unbound-observation-variant",
  );
  const recipe = definition(attempt),
    policy = candidatePolicy(attempt);
  const read = (path) => {
    assert(seen.has(path), `missing-variant-artifact:${path}`);
    return readFileSync(join(directory, path));
  };
  const json = (path) => JSON.parse(read(path));
  const endpoint = new URL(inputs.endpoint);
  assert(
    endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" &&
      endpoint.port &&
      endpoint.pathname === "/v1" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    "untrusted-provider-endpoint",
  );
  const key = inputs.env?.ROCKY_SYNTHETIC_ONLY_KEY;
  assert.match(
    key,
    /^synthetic-[a-f0-9-]{36}$/,
    "missing-private-synthetic-connection-key",
  );
  assert.deepEqual(
    inputs.env,
    {
      ...policy.environment,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      ROCKY_SYNTHETIC_ONLY_KEY: key,
    },
    "unexpected-native-environment",
  );
  assert.deepEqual(
    inputs.args,
    ["app-server", "--listen", "stdio://"],
    "native-launch-overrides",
  );
  assert.deepEqual(
    inputs.stdio,
    ["pipe", "pipe", "pipe"],
    "unexpected-inherited-descriptors",
  );
  assert.deepEqual(
    inputs.permissionOverrides,
    [],
    "native-permission-overrides",
  );
  assert.equal(inputs.cwd, recipe.source, "native-launch-cwd-mismatch");
  assert.deepEqual(
    inputs.binary,
    { path: BINARY, sha256: BINARY_SHA },
    "native-binary-identity-mismatch",
  );
  assert.deepEqual(
    inputs.nativeExecutables,
    spec.nativeExecutables,
    "native-executable-identity-mismatch",
  );
  assert.equal(inputs.os, spec.os, "native-platform-identity-mismatch");
  assert.deepEqual(json("policy.json"), policy, "actual-policy-mismatch");
  const config = nativeConfig(attempt, inputs.endpoint);
  assert.equal(
    read("runtime/codex-home/config.toml").toString(),
    config,
    "actual-config-not-declared-policy",
  );
  assert.equal(
    read("requested-config.toml").toString(),
    config,
    "requested-config-mismatch",
  );
  for (const path of [
    "config-after-thread.json",
    "config-after-cleanup.json",
  ]) {
    assert.deepEqual(
      json(path),
      {
        path: join(policy.environment.CODEX_HOME, "config.toml"),
        sha256: sha(config),
        expected: sha(config),
      },
      "config-observation-mismatch",
    );
  }
  assert.equal(
    inputs.policySha256,
    sha(read("policy.json")),
    "policy-identity-mismatch",
  );
  const sourceEntries = spec.sourceFiles.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
  }));
  assert.deepEqual(
    inventory(join(directory, "loaded-native-source")),
    sourceEntries,
    "native-source-reference-mismatch",
  );
  for (const entry of sourceEntries)
    assert.equal(
      sha(read(`loaded-native-source/${entry.path}`)),
      entry.sha256,
      "native-source-reference-changed",
    );
  function helpers(h) {
    const root = join(policy.environment.CODEX_HOME, "tmp/arg0");
    assert.equal(h.root, root, "wrong-helper-root");
    assert.equal(h.entries?.length, 4, "missing-helper-observations");
    const wrapper = h.wrapper;
    assert(
      typeof wrapper === "string" &&
        wrapper.startsWith(root + "/codex-arg0") &&
        /^codex-arg0[A-Za-z0-9]+\/codex-execve-wrapper$/.test(
          wrapper.slice(root.length + 1),
        ),
      "ambiguous-helper-wrapper",
    );
    const dir = wrapper.slice(0, -"codex-execve-wrapper".length);
    assert.deepEqual(
      h.entries,
      [
        { path: dir + ".lock", type: "file", bytes: 0, sha256: sha("") },
        ...["apply_patch", "applypatch", "codex-execve-wrapper"].map(
          (name) => ({
            path: dir + name,
            type: "symlink",
            target: BINARY,
            targetSha256: BINARY_SHA,
          }),
        ),
      ],
      "unbound-helper-identity",
    );
    return h;
  }
  const first = helpers(json("helpers-after-thread.json"));
  assert.deepEqual(
    helpers(json("helpers-before-dispatch.json")),
    first,
    "helper-changed-before-dispatch",
  );
  const leaders = journal.filter((r) => r.type === "app-start");
  assert.equal(leaders.length, 1, "missing-or-ambiguous-native-owner");
  const leader = leaders[0].value;
  assert(
    Number.isSafeInteger(leader.pid) &&
      leader.pid > 0 &&
      leader.pgid === leader.pid &&
      typeof leader.start === "string" &&
      leader.start.length > 0,
    "invalid-native-owner",
  );
  const preflights = journal.filter(
    (r) => r.type === "native-dispatch-preflight",
  );
  assert.equal(preflights.length, 4, "missing-dispatch-preflights");
  for (const [i, row] of preflights.entries()) {
    assert.equal(row.value.request, i + 1, "preflight-request-mismatch");
    assert.equal(
      row.value.configSha256,
      sha(config),
      "dispatch-config-changed",
    );
    assert.deepEqual(
      helpers(row.value.helpers),
      first,
      "dispatch-helper-changed",
    );
    assert.equal(row.value.noPermissionOverrides, true, "dispatch-overrides");
    assert(leaders[0].seq < row.seq, "dispatch-before-native-owner");
    assert(
      Array.isArray(row.value.ownedProcesses),
      "missing-dispatch-ownership",
    );
    assert.deepEqual(
      row.value.ownedProcesses.find((p) => p.pid === leader.pid),
      leader,
      "native-owner-changed",
    );
    const pids = new Set();
    for (const process of row.value.ownedProcesses) {
      assert(
        Number.isSafeInteger(process.pid) &&
          process.pid > 0 &&
          process.pgid === leader.pid &&
          !pids.has(process.pid),
        "unbound-dispatch-process",
      );
      pids.add(process.pid);
    }
    const requestRow = journal.find(
      (r) => r.type === "upstream-request" && r.value.number === i + 1,
    );
    const dispatch = journal.find(
      (r) => r.type === "upstream-response-event" && r.value.request === i + 1,
    );
    assert(
      requestRow &&
        dispatch &&
        requestRow.seq < row.seq &&
        row.seq < dispatch.seq,
      "preflight-not-before-dispatch",
    );
  }
  for (const [i, request] of requests.entries()) {
    assert.equal(request.method, "POST", "wrong-provider-method");
    assert.equal(request.url, "/v1/responses", "wrong-provider-route");
    assert.equal(
      request.headers?.authorization,
      `Bearer ${key}`,
      "unauthenticated-synthetic-request",
    );
    assert.equal(
      request.connection?.remoteAddress,
      "127.0.0.1",
      "nonlocal-synthetic-request",
    );
    assert.equal(
      request.connection?.localPort,
      Number(endpoint.port),
      "wrong-provider-listener",
    );
    assert.equal(
      request.connection?.requestNumber,
      i + 1,
      "replayed-provider-connection-record",
    );
    assert.deepEqual(
      request.body.tools,
      json("tool-roster.json"),
      "provider-tool-roster-changed",
    );
    assert(
      Number.isInteger(request.connection?.remotePort) &&
        request.connection.remotePort > 0,
      "missing-provider-connection",
    );
  }
  const canary = read("private/protected-canary.txt");
  assert(
    canary.length > 0 &&
      canary.length === before.protectedBytes &&
      sha(canary) === before.protectedSha256 &&
      sha(canary) === after.protectedSha256,
    "protected-oracle-mismatch",
  );
  assert(
    !JSON.stringify(journal).includes(canary.toString()) &&
      !requests.some((r) => r.raw.includes(canary.toString())),
    "protected-canary-leaked",
  );
  for (const [path, expected] of [
    ["source/allowed.txt", "allowed-native-control"],
    ["scratch/tmp/allowed.txt", "allowed-scratch-control"],
  ])
    assert.equal(
      read(path).toString(),
      expected,
      "missing-actual-positive-effect",
    );
  const guardian = read("guardian.jsonl")
    .toString()
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(guardian.length, 1, "ambiguous-guardian-outcome");
  assert.equal(guardian[0].type, "normal-stop", "guardian-recovery-not-normal");
  const cleanup = json("cleanup.json");
  const terminal = journal.find(
    (r) => r.type === "ipc-receive" && r.value.method === "turn/completed",
  );
  assert(
    terminal &&
      Number.isSafeInteger(guardian[0].at) &&
      guardian[0].at >= terminal.at &&
      guardian[0].at <= cleanup.finished,
    "guardian-outside-terminal-cleanup",
  );
  assert.equal(
    read("guardian.stop").toString(),
    "normal cleanup\n",
    "missing-normal-guardian-stop",
  );
}
