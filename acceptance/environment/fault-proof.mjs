// A classification is evidence only inside the exact injected operation. It is
// never a completion signal for prerequisite, transport, recovery or cleanup.
export const FAULT_PROVENANCE = {
  X01: [
    "fixture_failed",
    "wrong-fixture-password",
    "expected-valid-fixture-password-rejected",
  ],
  X02: [
    "fixture_failed",
    "enrolled-fresh-account",
    "2fa-fixture-already-consumed",
  ],
  X03: [
    "fixture_failed",
    "initialized-db-as-fresh",
    "initialized-fresh-install-fixture",
  ],
  X04: ["environment_failed", "waitForFunction-false", "owned-browser-timeout"],
  X05: ["environment_failed", "owned-service-death", "owned-service-death"],
  X06: [
    "product_failed",
    "corrupted-persistence-receipt",
    "username-persistence-mismatch",
  ],
  X07: [
    "isolation_failed",
    "foreign-container-offer",
    "foreign-process-identity",
  ],
  X08: [
    "isolation_failed",
    "prior-cycle-description",
    "prior-fixture-survived",
  ],
  X09: ["environment_failed", "owned-tmpfs-fill", "owned-tmpfs-exhaustion"],
  X10: ["cancelled", "cancel-owned-command", "cancel-during-owned-command"],
  X11: [
    "evidence_missing",
    "altered-presented-bindings",
    "altered-binding-rejected",
  ],
};
export class FaultProof {
  constructor(id, expected) {
    this.id = id;
    this.spec = FAULT_PROVENANCE[id];
    if (!this.spec || this.spec[0] !== expected)
      throw Error("fault-contract-drift");
    this.events = [];
    this.failed = false;
  }
  add(stage, evidence) {
    const order = [
      "prerequisites",
      "injection",
      "observation",
      "containment",
      "terminal",
    ];
    if (
      this.failed ||
      order[this.events.length] !== stage ||
      !evidence ||
      !Object.keys(evidence).length
    )
      throw Error("fault-proof-incomplete-or-out-of-order:" + stage);
    this.events.push({ stage, at: new Date().toISOString(), evidence });
  }
  prerequisites(evidence) {
    this.add("prerequisites", evidence);
  }
  inject(evidence) {
    if (evidence.operation !== this.spec[1])
      throw Error("wrong-fault-injection-provenance");
    this.add("injection", evidence);
  }
  observe(classification, reason) {
    if (classification !== this.spec[0] || reason !== this.spec[2])
      throw Error("wrong-fault-observation-provenance");
    this.add("observation", { classification, reason });
  }
  contain(evidence) {
    this.add("containment", evidence);
  }
  finish() {
    this.add("terminal", { intendedProbeCompleted: true });
  }
  fail(error) {
    this.failed = true;
    this.failure = {
      phase: this.events.at(-1)?.stage ?? "before-prerequisites",
      classification: error.classification ?? "unknown",
    };
  }
  passed() {
    return !this.failed && this.events.length === 5;
  }
  receipt() {
    return {
      id: this.id,
      events: this.events,
      passed: this.passed(),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }
}
export async function expectFailure(
  operation,
  classification,
  assertion,
  message,
) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  if (
    !caught ||
    caught.classification !== classification ||
    caught.assertion !== assertion ||
    caught.message !== message
  )
    throw Error("intended-fault-assertion-not-observed");
  return { classification, assertion, message };
}
export async function injectedTimeout(operation) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  if (
    caught?.name !== "TimeoutError" ||
    !/page\.waitForFunction: Timeout 250ms exceeded/.test(caught.message)
  )
    throw Error("intended-250ms-wait-timeout-not-observed");
  return {
    operation: "page.waitForFunction",
    timeoutMs: 250,
    name: caught.name,
    message: caught.message,
  };
}
