import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

export class ObservationFailure extends Error {
  constructor(classification, assertion, reason) {
    super(reason);
    this.classification = classification;
    this.assertion = assertion;
  }
}
export function requireObservation(
  condition,
  classification,
  assertion,
  reason,
) {
  if (!condition)
    throw new ObservationFailure(classification, assertion, reason);
}
export function permissions(me, role) {
  requireObservation(
    me && Number.isSafeInteger(me.id) && me.isEmailVerified === true,
    "fixture_failed",
    "ENV06",
    "unverified-account",
  );
  const actual = [...me.effectivePermissions].sort();
  const expected =
    role === "member"
      ? ["resources.read", "resources.update"]
      : ["resources.read"];
  if (role === "admin")
    requireObservation(
      actual.includes("resources.update") && actual.includes("users.update"),
      "fixture_failed",
      "ENV06",
      "admin-permissions-missing",
    );
  else
    requireObservation(
      JSON.stringify(actual) === JSON.stringify(expected),
      "fixture_failed",
      "ENV06",
      "unexpected-permissions",
    );
  return { id: me.id, username: me.username, permissions: actual };
}
export function persisted(saved, reloaded, authoritative, expected) {
  requireObservation(
    saved === 200 && reloaded === expected && authoritative === expected,
    "product_failed",
    "ENV07",
    "username-persistence-mismatch",
  );
}
export function fresh2fa(status) {
  requireObservation(
    status.enabled === false,
    "fixture_failed",
    "ENV09",
    "2fa-fixture-already-consumed",
  );
}
export function freshInstall(status) {
  requireObservation(
    status.available === true &&
      ["app", "smtp", "admin", "adminEmailVerified"].every(
        (k) => status.stepsCompleted?.[k] === false,
      ),
    "fixture_failed",
    "ENV10",
    "initialized-fresh-install-fixture",
  );
}
export function clean(receipt) {
  requireObservation(
    receipt.status === "complete" &&
      receipt.elapsedMs <= 30000 &&
      receipt.pendingMutations?.length === 0 &&
      receipt.errors?.length === 0 &&
      ["containers", "networks", "browsers"].every(
        (k) =>
          Array.isArray(receipt.remaining?.[k]) &&
          receipt.remaining[k].length === 0,
      ),
    "isolation_failed",
    "ENV13",
    "cleanup-incomplete-or-over-budget",
  );
}
export function totp(uri, seconds = Date.now() / 1000) {
  const u = new URL(uri);
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.hostname, "totp");
  const secret = u.searchParams.get("secret");
  const algorithm = (u.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
  const digits = Number(u.searchParams.get("digits") ?? "6"),
    period = Number(u.searchParams.get("period") ?? "30");
  assert.match(secret ?? "", /^[A-Z2-7]+=*$/i);
  assert.ok(["sha1", "sha256", "sha512"].includes(algorithm));
  assert.ok([6, 8].includes(digits));
  assert.ok(Number.isSafeInteger(period) && period > 0);
  let bits = 0,
    buffer = 0;
  const bytes = [];
  for (const c of secret.toUpperCase().replace(/=+$/, "")) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / period)));
  const hmac = createHmac(algorithm, Buffer.from(bytes))
      .update(counter)
      .digest(),
    offset = hmac[hmac.length - 1] & 15;
  return String(
    (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}

export function assertionResults(required, values, completed, outcome) {
  return required.map((assertion) => ({
    assertion,
    status:
      outcome.failure?.assertion === assertion ||
      (assertion === "ENV13" && outcome.cleanupError) ||
      (assertion === "ENV14" && outcome.evidenceError)
        ? "failed"
        : completed.has(assertion) &&
            (values.get(assertion) ?? []).length > 0 &&
            (values.get(assertion) ?? []).every(
              (e) =>
                typeof e.path === "string" &&
                e.path.length > 0 &&
                /^[a-f0-9]{64}$/.test(e.sha256),
            )
          ? "passed"
          : "blocked",
    evidence: values.get(assertion) ?? [],
  }));
}
