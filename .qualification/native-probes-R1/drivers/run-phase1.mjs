// R1 phase 1 — CC-P0 + CX-P0 binary identity re-measure (precondition; NO spawn).
// Uses the SHIPPED measureBinaryIdentity (dist/runner/process.js) so the identity check binds to
// shipped code. Mismatch/missing ⇒ ENVIRONMENT_FAILURE + FULL STOP (G-VERSION unavailable, never substituted).
import {
  PINS,
  proc,
  EVID,
  probeDir,
  writeJSON,
  writeVerdict,
  consume,
  isConsumed,
  managedLayerInventory,
  errName,
} from "./lib.mjs";
import { lstatSync, readlinkSync } from "node:fs";

function measure(probeId, label, pin) {
  const dir = probeDir(probeId);
  const rec = { probeId, label, pin, measured: null, error: null };
  let verdict, cls, observed;
  try {
    const m = proc.measureBinaryIdentity(pin.path);
    rec.measured = m;
    const match = m.sha256 === pin.sha256 && m.bytes === pin.bytes;
    observed = `measured sha256=${m.sha256} bytes=${m.bytes} path=${m.path}`;
    if (match) {
      verdict = "PASS";
      cls = "identity-match";
    } else {
      verdict = "ENVIRONMENT_FAILURE";
      cls = "identity-drift";
    }
  } catch (e) {
    rec.error = errName(e);
    observed = `measure threw: ${errName(e)}`;
    verdict = "ENVIRONMENT_FAILURE";
    cls = "identity-missing-or-unmeasurable";
  }
  writeJSON(dir + "/meta.json", rec);
  writeVerdict(probeId, {
    verdict,
    tier: "precondition",
    gate: "G-VERSION",
    hypothesis: `${label} pinned binary identity re-measures equal to the frozen pin (sha256+bytes+path).`,
    criterion:
      "PART4/PART2 CC-P0/CX-P0: 'binary identity re-measure vs pin. No spawn. Fail ⇒ ENVIRONMENT_FAILURE, stop all; never spawn symlink/Homebrew/other-version paths.'",
    expected: `sha256=${pin.sha256} bytes=${pin.bytes} at ${pin.path}`,
    observed,
    class: cls,
    notes: `No spawn. Read/hash only. ${
      verdict === "PASS"
        ? "Identity matches pin; batch may proceed."
        : "FULL STOP: identity drift/missing; profile unavailable, never substituted."
    }`,
  });
  consume(probeId, verdict);
  return { verdict, rec };
}

const results = [];
for (const [probeId, label, pin] of [
  ["CC-P0", "claude 2.1.283", PINS.claude],
  ["CX-P0", "codex 0.157.1", PINS.codex],
]) {
  if (isConsumed(probeId)) {
    results.push({ probeId, verdict: "ALREADY-CONSUMED" });
    continue;
  }
  results.push(measure(probeId, label, pin));
}

// Never-spawn note: lstat the moving symlink (name only) to document auto-updater drift.
let symlink = null;
try {
  const st = lstatSync("/Users/jappy/.local/bin/claude");
  symlink = {
    present: true,
    isSymlink: st.isSymbolicLink(),
    target: st.isSymbolicLink() ? readlinkSync("/Users/jappy/.local/bin/claude") : null,
  };
} catch {
  symlink = { present: false };
}
// G-MANAGED real-host pre-run inventory (names/lstat only; contents never read).
const managed = managedLayerInventory();
writeJSON(EVID + "/probes/CC-P0/inventories/managed-layer-pre.json", {
  symlinkNeverSpawn: symlink,
  managed,
});
writeJSON(EVID + "/probes/CX-P0/inventories/managed-layer-pre.json", {
  symlinkNeverSpawn: symlink,
  managed,
});

const fullStop = results.some((r) => r.verdict === "ENVIRONMENT_FAILURE");
console.log(
  JSON.stringify(
    {
      phase: 1,
      results: results.map((r) => ({
        probeId: r.probeId ?? r.rec?.probeId,
        verdict: r.verdict,
      })),
      symlinkNeverSpawn: symlink,
      managedAllAbsent: managed.every((m) => !m.present),
      FULL_STOP: fullStop,
    },
    null,
    2
  )
);
process.exit(fullStop ? 2 : 0);
