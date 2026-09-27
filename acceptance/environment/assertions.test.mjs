import test from "node:test";
import assert from "node:assert/strict";
import {
  totp,
  persisted,
  fresh2fa,
  freshInstall,
  clean,
  permissions,
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
