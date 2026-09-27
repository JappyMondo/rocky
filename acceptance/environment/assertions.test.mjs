import test from "node:test";
import assert from "node:assert/strict";
import {
  totp,
  persisted,
  fresh2fa,
  freshInstall,
  clean,
  permissions,
  roleAssignments,
  ObservationFailure,
  assertionResults,
} from "./assertions.mjs";
test("RFC6238 Appendix B SHA1 vectors, including beyond 32-bit time", () => {
  const uri =
    "otpauth://totp/example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA1&digits=8&period=30";
  for (const [time, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])
    assert.equal(totp(uri, time), expected);
});
test("reject successful save with different authoritative value", () =>
  assert.throws(
    () => persisted(200, "wanted", "old", "wanted"),
    (e) => e.classification === "product_failed" && e.assertion === "ENV07",
  ));
test("reject consumed 2FA and initialized wizard fixtures", () => {
  assert.throws(() => fresh2fa({ enabled: true }), ObservationFailure);
  assert.throws(
    () =>
      freshInstall({
        available: true,
        stepsCompleted: {
          app: true,
          smtp: false,
          admin: false,
          adminEmailVerified: false,
        },
      }),
    ObservationFailure,
  );
});
test("empty resource listing cannot conceal pending Docker mutations", () =>
  assert.throws(
    () =>
      clean({
        status: "complete",
        elapsedMs: 1,
        pendingMutations: [{ key: "create" }],
        errors: [],
        remaining: { containers: [], networks: [], browsers: [] },
      }),
    ObservationFailure,
  ));
test("denied role must not have update or unrelated elevated grants", () =>
  assert.throws(
    () =>
      permissions(
        {
          id: 3,
          isEmailVerified: true,
          effectivePermissions: ["resources.read", "resources.update"],
        },
        "denied",
      ),
    ObservationFailure,
  ));

test("partial wizard evidence cannot complete ENV10; later failure overrides earlier observations", () => {
  const values = new Map([["ENV10", [{ phase: "initial" }]]]);
  assert.equal(
    assertionResults(["ENV10"], values, new Set(), {})[0].status,
    "blocked",
  );
  assert.equal(
    assertionResults(["ENV10"], values, new Set(["ENV10"]), {
      failure: { assertion: "ENV10" },
    })[0].status,
    "failed",
  );
});

test("every assertion needs terminal checkpoint plus hashed evidence, even after partial observations", () => {
  for (let i = 1; i <= 14; i++) {
    const id = "ENV" + String(i).padStart(2, "0"),
      values = new Map([
        [id, [{ path: "/retained/evidence", sha256: "a".repeat(64) }]],
      ]);
    assert.equal(
      assertionResults([id], values, new Set(), {})[0].status,
      "blocked",
    );
    assert.equal(
      assertionResults([id], new Map(), new Set([id]), {})[0].status,
      "blocked",
    );
    assert.equal(
      assertionResults(
        [id],
        new Map([[id, [{ path: "/retained/evidence" }]]]),
        new Set([id]),
        {},
      )[0].status,
      "blocked",
    );
    assert.equal(
      assertionResults([id], values, new Set([id]), {})[0].status,
      "passed",
    );
  }
});

test("role assignment checks reject wrong user, duplicate, elevated key and renamed administrator", () => {
  const user = { id: 2 };
  const base = {
    id: 2,
    userId: 2,
    roleId: 1,
    source: "manual",
    role: { id: 1, key: "user", isSystemManaged: true, isDefault: true },
  };
  roleAssignments([base], user, "denied", "cycle");
  for (const assignments of [
    [],
    [base, base],
    [{ ...base, userId: 3 }],
    [{ ...base, roleId: 3 }],
    [{ ...base, role: { ...base.role, key: "administrator", name: "User" } }],
  ])
    assert.throws(
      () => roleAssignments(assignments, user, "denied", "cycle"),
      ObservationFailure,
    );
  const custom = {
    id: 3,
    userId: 2,
    roleId: 4,
    source: "manual",
    role: {
      id: 4,
      key: "custom-key",
      name: "role-cycle",
      isSystemManaged: false,
      isDefault: false,
    },
  };
  roleAssignments([base, custom], user, "member", "cycle");
  assert.throws(
    () =>
      roleAssignments(
        [base, { ...custom, role: { ...custom.role, key: "administrator" } }],
        user,
        "member",
        "cycle",
      ),
    ObservationFailure,
  );
});

test("transient unavailable API is not explicit automatic exit proof", async () => {
  const { automaticExit } = await import("./service-observation.mjs");
  const before = {
    sockets: [{ port: 3000, owners: [42] }],
    processes: [{ pid: 42, startTicks: "123" }],
  };
  const after = {
    sockets: [],
    processes: [],
    commandId: "read-only-observation",
  };
  assert.throws(() => automaticExit(before, after, ""), ObservationFailure);
  const log =
    "api: [Nest] 42  - date [PluginService] Restarting app by exiting\napi: NX Process exited with code 0, waiting for changes to restart...";
  assert.throws(
    () => automaticExit(before, { ...after, processes: before.processes }, log),
    ObservationFailure,
  );
  assert.equal(automaticExit(before, after, log).explicitExitCode, 0);
});
