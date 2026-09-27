import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  readFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest, identity } from "../store/json.js";
export interface EvidenceInputs {
  head: string;
  base: string;
  scope: string;
  scenario: string;
  fixture: string;
  command: string;
  toolchain: string;
  [key: string]: string;
}
export interface Artifact {
  sha256: string;
  bytes: number;
}
export interface Receipt {
  schema: 1;
  kind: string;
  inputs: EvidenceInputs;
  outcome: "pass" | "fail" | "blocked";
  artifacts: Artifact[];
}
export class Evidence {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  #path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid-artifact-id");
    return join(this.root, hash);
  }
  put(bytes: string | Uint8Array): Artifact {
    const data = Buffer.from(bytes);
    const sha256 = digest(data);
    const path = this.#path(sha256);
    const temporary = join(this.root, "." + randomUUID());
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.read({ sha256, bytes: data.length });
    } finally {
      unlinkSync(temporary);
    }
    const dir = openSync(this.root, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return { sha256, bytes: data.length };
  }
  read(artifact: Artifact): Buffer {
    let data: Buffer;
    try {
      data = readFileSync(this.#path(artifact.sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("missing-evidence");
      throw error;
    }
    if (data.length !== artifact.bytes || digest(data) !== artifact.sha256)
      throw new Error("evidence-integrity-failure");
    return data;
  }
  record(receipt: Receipt): Artifact {
    validateInputs(receipt.inputs);
    if (
      receipt.schema !== 1 ||
      !["pass", "fail", "blocked"].includes(receipt.outcome) ||
      !receipt.kind
    )
      throw new Error("invalid-receipt");
    for (const artifact of receipt.artifacts) this.read(artifact);
    return this.put(canonical(receipt));
  }
  validate(
    reference: Artifact,
    current: EvidenceInputs,
  ): { valid: boolean; reason: string; receipt?: Receipt } {
    try {
      validateInputs(current);
      const receipt = JSON.parse(this.read(reference).toString()) as Receipt;
      if (receipt.schema !== 1) throw new Error("incompatible-evidence-schema");
      for (const artifact of receipt.artifacts) this.read(artifact);
      if (identity(receipt.inputs) !== identity(current))
        return { valid: false, reason: "stale-inputs", receipt };
      return {
        valid: receipt.outcome === "pass",
        reason: receipt.outcome,
        receipt,
      };
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : "invalid-evidence",
      };
    }
  }
}
function validateInputs(inputs: EvidenceInputs) {
  for (const key of [
    "head",
    "base",
    "scope",
    "scenario",
    "fixture",
    "command",
    "toolchain",
  ])
    if (typeof inputs[key] !== "string" || !inputs[key])
      throw new Error("missing-evidence-identity");
}
/** Historical receipts never authorize new browser work. Probe at the point of each new execution. */
export async function withFreshReadiness<T>(
  probe: () => Promise<boolean>,
  execute: () => Promise<T>,
): Promise<T> {
  if (!(await probe())) throw new Error("service-not-ready");
  return execute();
}
