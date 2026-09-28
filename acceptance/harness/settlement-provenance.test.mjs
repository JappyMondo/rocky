import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ROOT,
  BINARY,
  BINARY_SHA,
  sha,
  inventory,
  guard,
  save,
} from "./common.mjs";
import { definition } from "./fixture.mjs";
import { candidatePolicy } from "./policy.mjs";
import { nativeConfig } from "./native-config.mjs";
import { verifySettlementProvenance } from "./settlement-provenance.mjs";
import { settlementFixture, refresh } from "./settlement-fixtures.mjs";

guard();
const root = join(
  ROOT,
  ".qualification/harness-settlement-68",
  `provenance-selftest-${Date.now()}`,
);
mkdirSync(root, { recursive: true, mode: 0o700 });
let count = 0;
const results = [];
after(() =>
  save(join(root, "results.json"), {
    classification: "synthetic-static-provenance-test",
    results,
  }),
);
const reference = {
  observationVariant: JSON.parse(
    readFileSync(join(ROOT, "acceptance/harness/manifest.json")),
  ).observationVariant,
};
function fixture() {
  const f = settlementFixture();
  f.directory = join(root, `case-${++count}`);
  f.policy = candidatePolicy(f.admission.attempt);
  f.write = (path, bytes) => {
    const target = join(f.directory, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  };
  f.json = (path, value) => f.write(path, JSON.stringify(value));
  f.inputs = {
    ...f.inputs,
    endpoint: "http://127.0.0.1:45123/v1",
    binary: { path: BINARY, sha256: BINARY_SHA },
    env: {
      ...f.policy.environment,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/sh",
      LANG: "en_US.UTF-8",
      ROCKY_SYNTHETIC_ONLY_KEY:
        "synthetic-00000000-0000-0000-0000-000000000068",
    },
    args: ["app-server", "--listen", "stdio://"],
    stdio: ["pipe", "pipe", "pipe"],
    permissionOverrides: [],
    cwd: definition(f.admission.attempt).source,
    nativeExecutables: structuredClone(
      reference.observationVariant.nativeExecutables,
    ),
    os: reference.observationVariant.os,
  };
  f.json("policy.json", f.policy);
  f.inputs.policySha256 = sha(readFileSync(join(f.directory, "policy.json")));
  f.config = nativeConfig(f.admission.attempt, f.inputs.endpoint);
  for (const path of [
    "runtime/codex-home/config.toml",
    "requested-config.toml",
  ])
    f.write(path, f.config);
  for (const path of ["config-after-thread.json", "config-after-cleanup.json"])
    f.json(path, {
      path: join(f.policy.environment.CODEX_HOME, "config.toml"),
      sha256: sha(f.config),
      expected: sha(f.config),
    });
  for (const entry of reference.observationVariant.sourceFiles)
    f.write(
      "loaded-native-source/" + entry.path,
      readFileSync(
        join(
          ROOT,
          ".qualification/harness-settlement-68/pinned-source",
          entry.path,
        ),
      ),
    );
  const helperRoot = join(f.policy.environment.CODEX_HOME, "tmp/arg0"),
    dir = join(helperRoot, "codex-arg0Synthetic");
  const helpers = {
    root: helperRoot,
    wrapper: join(dir, "codex-execve-wrapper"),
    entries: [
      { path: join(dir, ".lock"), type: "file", bytes: 0, sha256: sha("") },
      ...["apply_patch", "applypatch", "codex-execve-wrapper"].map((name) => ({
        path: join(dir, name),
        type: "symlink",
        target: BINARY,
        targetSha256: BINARY_SHA,
      })),
    ],
  };
  for (const path of [
    "helpers-after-thread.json",
    "helpers-before-dispatch.json",
  ])
    f.json(path, helpers);
  const leader = {
    pid: 111,
    ppid: 110,
    pgid: 111,
    start: "synthetic-static-time",
    command: BINARY,
  };
  f.journal.unshift({ type: "app-start", value: leader });
  refresh(f);
  for (const row of f.journal.filter(
    (r) => r.type === "native-dispatch-preflight",
  ))
    row.value = {
      ...row.value,
      configSha256: sha(f.config),
      helpers: structuredClone(helpers),
      noPermissionOverrides: true,
      ownedProcesses: [structuredClone(leader)],
    };
  for (const [i, request] of f.requests.entries())
    Object.assign(request, {
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: `Bearer ${f.inputs.env.ROCKY_SYNTHETIC_ONLY_KEY}`,
      },
      connection: {
        remoteAddress: "127.0.0.1",
        remotePort: 50000 + i,
        localPort: 45123,
        requestNumber: i + 1,
      },
    });
  f.json("tool-roster.json", f.roster);
  f.write("private/protected-canary.txt", "fake");
  f.write("source/allowed.txt", "allowed-native-control");
  f.write("scratch/tmp/allowed.txt", "allowed-scratch-control");
  f.json("cleanup.json", f.observations.cleanup);
  f.write("guardian.stop", "normal cleanup\n");
  f.write(
    "guardian.jsonl",
    JSON.stringify({ type: "normal-stop", at: 98 }) + "\n",
  );
  return f;
}
function check(f) {
  // Logical authority root is derived by production checkAttempt. Static tests
  // relocate ONLY retained file reads; no admitted native directory is created.
  const seen = new Set(inventory(f.directory).map((e) => e.path));
  verifySettlementProvenance(
    f.directory,
    f.inputs,
    seen,
    reference,
    f.journal,
    f.requests,
    f.before,
    f.after,
    f.admission.attempt,
  );
}
test("complete synthetic provenance fixture validates exact bound bytes", () => {
  const f = fixture();
  check(f);
  results.push({ label: "positive", status: "pass" });
});
test("extracted renderer reproduces exact historical runtime config bytes", () => {
  const attempt = join(
    ROOT,
    ".qualification/harness-native-64/attempt-2026-09-28T02-35-51.938Z",
  );
  const inputs = JSON.parse(readFileSync(join(attempt, "inputs.json")));
  assert.equal(
    nativeConfig(attempt, inputs.endpoint),
    readFileSync(join(attempt, "runtime/codex-home/config.toml"), "utf8"),
  );
});
const cases = [
  [
    "missing native owner",
    (f) => {
      f.journal = f.journal.filter((r) => r.type !== "app-start");
    },
  ],
  [
    "changed native owner",
    (f) => {
      f.journal.find(
        (r) => r.type === "native-dispatch-preflight",
      ).value.ownedProcesses[0].start = "changed";
    },
  ],
  [
    "missing guardian stop",
    (f) => unlinkSync(join(f.directory, "guardian.stop")),
  ],
  [
    "missing actual config",
    (f) => unlinkSync(join(f.directory, "runtime/codex-home/config.toml")),
  ],
  [
    "changed actual config with fresh inventory",
    (f) => f.write("runtime/codex-home/config.toml", f.config + "# changed\n"),
  ],
  [
    "changed actual requested and observed config",
    (f) => {
      const x = f.config.replace(
        'default_permissions = "probe"',
        'default_permissions = "other"',
      );
      for (const p of [
        "runtime/codex-home/config.toml",
        "requested-config.toml",
      ])
        f.write(p, x);
      for (const p of ["config-after-thread.json", "config-after-cleanup.json"])
        f.json(p, {
          path: join(f.policy.environment.CODEX_HOME, "config.toml"),
          sha256: sha(x),
          expected: sha(x),
        });
    },
  ],
  [
    "missing observed config",
    (f) => unlinkSync(join(f.directory, "config-after-cleanup.json")),
  ],
  [
    "wrong config observation path",
    (f) =>
      f.json("config-after-thread.json", {
        path: "other",
        sha256: sha(f.config),
        expected: sha(f.config),
      }),
  ],
  [
    "unexpected env",
    (f) => {
      f.inputs.env.REAL_AUTH = "not supplied";
    },
  ],
  [
    "missing CODEX_HOME",
    (f) => {
      delete f.inputs.env.CODEX_HOME;
    },
  ],
  ["launcher override", (f) => f.inputs.args.push("-c", "permissions=other")],
  ["permission override", (f) => f.inputs.permissionOverrides.push("other")],
  [
    "wrong binary",
    (f) => {
      f.inputs.binary.sha256 = sha("other");
    },
  ],
  [
    "wrong shell identity",
    (f) => {
      f.inputs.nativeExecutables[0].sha256 = sha("other");
    },
  ],
  [
    "changed platform",
    (f) => {
      f.inputs.os = "other";
    },
  ],
  [
    "changed policy",
    (f) => {
      f.policy.filesystem["/tmp"] = "write";
      f.json("policy.json", f.policy);
      f.inputs.policySha256 = sha(
        readFileSync(join(f.directory, "policy.json")),
      );
    },
  ],
  [
    "missing native source",
    (f) => unlinkSync(join(f.directory, "loaded-native-source/context.rs")),
  ],
  [
    "changed native source with fresh inventory",
    (f) => f.write("loaded-native-source/context.rs", "changed"),
  ],
  [
    "missing helpers",
    (f) => unlinkSync(join(f.directory, "helpers-before-dispatch.json")),
  ],
  [
    "wrong helper target",
    (f) => {
      const h = JSON.parse(
        readFileSync(join(f.directory, "helpers-after-thread.json")),
      );
      h.entries[1].target = "/other";
      f.json("helpers-after-thread.json", h);
    },
  ],
  [
    "changed helper on dispatch",
    (f) => {
      f.journal.find(
        (r) => r.type === "native-dispatch-preflight",
      ).value.helpers.entries[2].targetSha256 = sha("changed");
    },
  ],
  [
    "missing preflight",
    (f) => {
      f.journal = f.journal.filter(
        (r) => r.type !== "native-dispatch-preflight",
      );
    },
  ],
  [
    "preflight after dispatch",
    (f) => {
      const p = f.journal.find((r) => r.type === "native-dispatch-preflight");
      f.journal.splice(f.journal.indexOf(p), 1);
      f.journal.push(p);
      refresh(f);
    },
  ],
  [
    "private result unauthenticated",
    (f) => {
      f.requests[2].headers.authorization = "Bearer other";
    },
  ],
  [
    "nonlocal request",
    (f) => {
      f.requests[2].connection.remoteAddress = "203.0.113.1";
    },
  ],
  [
    "wrong listener",
    (f) => {
      f.requests[2].connection.localPort = 45124;
    },
  ],
  [
    "changed roster",
    (f) => {
      f.requests[2].body.tools = [{ name: "other" }];
    },
  ],
  [
    "external provider",
    (f) => {
      f.inputs.endpoint = "https://example.invalid/v1";
    },
  ],
  [
    "missing canary",
    (f) => unlinkSync(join(f.directory, "private/protected-canary.txt")),
  ],
  [
    "changed canary",
    (f) => f.write("private/protected-canary.txt", "modified"),
  ],
  [
    "leaked canary IPC",
    (f) => {
      f.journal.push({ type: "app-stderr", value: "fake" });
    },
  ],
  [
    "leaked canary raw provider",
    (f) => {
      f.requests[2].raw += "fake";
    },
  ],
  [
    "missing source effect",
    (f) => unlinkSync(join(f.directory, "source/allowed.txt")),
  ],
  ["wrong scratch effect", (f) => f.write("scratch/tmp/allowed.txt", "wrong")],
  [
    "guardian recovery",
    (f) =>
      f.write(
        "guardian.jsonl",
        JSON.stringify({ type: "recovery-final" }) + "\n",
      ),
  ],
];
for (const [label, mutate] of cases)
  test(`variant provenance rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    let error;
    try {
      check(f);
    } catch (e) {
      error = e.message;
    }
    assert(error, label);
    results.push({ label, status: "rejected", error });
  });
