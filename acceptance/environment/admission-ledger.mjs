import {
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, workspace, sha } from "./runtime.mjs";

export const ADMISSION_ROOT = join(
  ROOT,
  ".qualification/attraccess/admission-attempts",
);
export function admissionSnapshot() {
  if (!existsSync(ADMISSION_ROOT)) return [];
  return readdirSync(ADMISSION_ROOT)
    .sort()
    .map((name) => {
      if (!/^[a-f0-9-]+\.jsonl$/.test(name))
        throw Error("unexpected-admission-ledger-file");
      const path = join(ADMISSION_ROOT, name),
        st = lstatSync(path);
      if (
        !st.isFile() ||
        st.size > 160 * 1024 ||
        realpathSync(path) !== path ||
        (st.mode & 0o077) !== 0
      )
        throw Error("invalid-admission-ledger-file");
      const bytes = readFileSync(path),
        events = bytes
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse),
        first = events[0],
        last = events.at(-1);
      return {
        path,
        sha256: sha(bytes),
        bytes: st.size,
        phase: first?.phase ?? "unrecorded-entry",
        status:
          last?.event === "admission-rejected"
            ? "rejected"
            : last?.event === "admission-admitted"
              ? "admitted"
              : "incomplete",
        scoredCredit: false,
      };
    });
}
function inputIdentity(path) {
  if (typeof path !== "string") return { supplied: false };
  const identity = { supplied: true, pathSha256: sha(path) };
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 16 * 1024 * 1024)
      return {
        ...identity,
        readable: false,
        reason: "not-bounded-regular-file",
      };
    return {
      ...identity,
      readable: true,
      bytes: st.size,
      sha256: sha(readFileSync(path)),
    };
  } catch (e) {
    return { ...identity, readable: false, reason: e.code ?? "unreadable" };
  }
}
export function rejection(error) {
  // Arbitrary dependency error text may contain auth/URL material. Retain a
  // precise stable code and message digest, never its unbounded raw content.
  const text = String(error?.message ?? error);
  const prefix = text.split(/[:\n]/, 1)[0];
  return {
    classification: [
      "fixture_failed",
      "product_failed",
      "environment_failed",
      "isolation_failed",
      "evidence_missing",
    ].includes(error?.classification)
      ? error.classification
      : "evidence_missing",
    reason: /^[a-z][a-z0-9-]{0,100}$/.test(prefix)
      ? prefix
      : "preflight-exception",
    errorCode: /^[A-Z][A-Z0-9_]{0,40}$/.test(error?.code ?? "")
      ? error.code
      : "NO_SYSTEM_CODE",
    messageSha256: sha(text),
  };
}
export async function admissionAttempt(
  { phase, admissionPath, approvalPath, seriesId = "pre-series" },
  validate,
) {
  workspace(); // Strict wrong-root/branch stop precedes *every* evidence write.
  if (!/^[a-z0-9-]+$/.test(phase) || !/^[a-zA-Z0-9-]+$/.test(seriesId))
    throw Error("invalid-admission-ledger-label");
  let fd, path;
  try {
    const parent = join(ROOT, ".qualification/attraccess");
    if (realpathSync(parent) !== parent)
      throw Error("noncanonical-evidence-parent");
    mkdirSync(ADMISSION_ROOT, { recursive: true, mode: 0o700 });
    if (
      realpathSync(ADMISSION_ROOT) !== ADMISSION_ROOT ||
      (lstatSync(ADMISSION_ROOT).mode & 0o077) !== 0
    )
      throw Error("admission-ledger-not-private");
    path = join(ADMISSION_ROOT, randomUUID() + ".jsonl");
    fd = openSync(path, "wx", 0o600);
    const dir = openSync(ADMISSION_ROOT, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    throw Error("admission-receipt-unavailable:" + rejection(error).reason);
  }
  const append = (event) => {
    const line =
      JSON.stringify({
        phase,
        seriesId,
        at: new Date().toISOString(),
        ...event,
      }) + "\n";
    if (Buffer.byteLength(line) > 16384)
      throw Error("admission-receipt-over-budget");
    writeSync(fd, line);
    fsyncSync(fd);
  };
  let entered = false,
    validationStage = "entry",
    checkpoints = 0;
  const checkpoint = (stage) => {
    if (!/^[a-z0-9-]{1,80}$/.test(stage) || ++checkpoints > 8)
      throw Error("admission-checkpoint-over-budget");
    validationStage = stage;
    append({
      event: "admission-checkpoint",
      validationStage,
      qualificationEffectsStarted: false,
    });
  };
  try {
    append({
      event: "admission-attempt",
      inputs: {
        admission: inputIdentity(admissionPath),
        approval: inputIdentity(approvalPath),
      },
      qualificationEffectsStarted: false,
    });
    entered = true;
    const value = await validate(checkpoint);
    append({ event: "admission-admitted", qualificationEffectsStarted: false });
    return { value, receipt: { path, sha256: sha(readFileSync(path)) } };
  } catch (error) {
    try {
      append({
        event: "admission-rejected",
        ...rejection(error),
        validationEntered: entered,
        validationStage,
        qualificationEffectsStarted: false,
      });
    } catch {
      throw Error("admission-rejection-receipt-unavailable:" + path);
    }
    error.admissionReceipt = { path, sha256: sha(readFileSync(path)) };
    throw error;
  } finally {
    closeSync(fd);
  }
}
