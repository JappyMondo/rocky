/**
 * Harness-neutral agent launch/settlement seam (Taskbot #97). Shared shapes for direct CLI
 * harness adapters — Claude Code (#95/#97) first, codex exec (#81) and OpenCode (#98) later:
 * an immutable audited launch bundle, one-shot raw UTF-8 input with a single EOF (durable
 * attempted-before-IO semantics owned by the duplex transport, reused not forked), a bounded
 * strict observed-event decode, terminal settlement classification
 * (complete/unresolved/policy-denied/fatal/interrupted) and usage normalization onto the #90
 * subscription-observed-v1 schema-2 statuses. Nothing harness-specific belongs in this module.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { canonical, digest, identity, type Json } from "../store/json.js";
import {
  validateEvent,
  validateUsage,
  type Action,
  type Event,
  type HarnessUsage,
} from "../coordinator/contracts.js";
import { validateSealedEnvEntries } from "../runner/index.js";
import type { BinaryIdentity } from "../runner/process.js";
export type { BinaryIdentity };
export type SealedEnv = readonly (readonly [string, string])[];

/** One immutable audited launch bundle: every byte the child can observe, digest-bound. */
export interface LaunchFileBinding {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
}
export interface AgentLaunchBundle {
  schema: 1;
  harness: string;
  binary: BinaryIdentity;
  argv: readonly string[];
  env: SealedEnv;
  cwd: string;
  input: { bytes: number; sha256: string };
  files: readonly LaunchFileBinding[];
  discoveryDigest: string;
  bundleDigest: string;
}
export function launchBundleDigest(
  bundle: Omit<AgentLaunchBundle, "bundleDigest">,
): string {
  return identity(bundle);
}
export function sealAgentLaunchBundle(
  bundle: Omit<AgentLaunchBundle, "bundleDigest">,
): AgentLaunchBundle {
  if (!bundle.harness || typeof bundle.harness !== "string")
    throw new Error("invalid-launch-bundle");
  if (!Array.isArray(bundle.argv) || !bundle.argv.length)
    throw new Error("invalid-launch-bundle");
  for (const element of bundle.argv)
    if (
      typeof element !== "string" ||
      !element ||
      element.includes("\0") ||
      /[\u0000-\u001f\u007f]/.test(element)
    )
      throw new Error("invalid-launch-bundle");
  validateSealedEnvEntries(bundle.env);
  if (!Number.isSafeInteger(bundle.input.bytes) || bundle.input.bytes < 1)
    throw new Error("invalid-launch-bundle");
  if (!/^[a-f0-9]{64}$/.test(bundle.input.sha256))
    throw new Error("invalid-launch-bundle");
  const value: AgentLaunchBundle = JSON.parse(
    canonical({ ...bundle, bundleDigest: "" }),
  ) as AgentLaunchBundle;
  const { bundleDigest: _ignored, ...rest } = value;
  return { ...value, bundleDigest: launchBundleDigest(rest) };
}

/** Terminal settlement classification, harness-neutral; `interrupted` covers cancel/deadline/
 * lease-loss/recovery and any lifecycle whose telemetry is unresolved. */
export type SettlementClass =
  | "complete"
  | "unresolved"
  | "policy-denied"
  | "fatal"
  | "interrupted";
export type AgentOutcome =
  | "changed"
  | "no_code"
  | "complete"
  | "failed"
  | "interrupted";
export interface AgentSettlement {
  schema: 1;
  harness: string;
  classification: SettlementClass;
  outcome: AgentOutcome;
  quiescent: boolean;
  usage: HarnessUsage;
  /** Host-derived from the staged tree, never from a model's final message. */
  head: string;
  detail: string;
  /** Validated structured final, a proposal only: never authoritative checks/CI/review/head. */
  proposal: Json | null;
}
export function settlementToResultEvent(
  settlement: AgentSettlement,
  action: Readonly<Action>,
): Extract<Event, { type: "result" }> {
  if (settlement.schema !== 1 || typeof settlement.harness !== "string")
    throw new Error("invalid-agent-settlement");
  // Interrupted settlements always settle as interrupted; an interrupted outcome is only honest
  // for an interrupted or unresolved classification (missing lifecycle/telemetry → recovery).
  if (
    settlement.classification === "interrupted" &&
    settlement.outcome !== "interrupted"
  )
    throw new Error("invalid-agent-settlement");
  if (
    settlement.outcome === "interrupted" &&
    !["interrupted", "unresolved"].includes(settlement.classification)
  )
    throw new Error("invalid-agent-settlement");
  const event: Extract<Event, { type: "result" }> = {
    type: "result",
    actionKey: action.key,
    inputDigest: action.inputDigest,
    quiescent: settlement.quiescent,
    usage: settlement.usage,
    outcome: settlement.outcome,
    head: settlement.head,
    detail: settlement.detail,
  };
  validateEvent(event, "transport");
  return event;
}

/** Schema-2 usage constructors. Reported totals are input+output with subset semantics;
 * subsets are never added twice and an all-zero total is never a known zero. */
export function reportedHarnessUsage(
  harness: string,
  receipt: string,
  components: {
    input: number;
    cachedInput: number | null;
    cacheWriteInput: number | null;
    output: number;
    reasoningOutput: number | null;
  },
): HarnessUsage {
  const usage: HarnessUsage = {
    schema: 2,
    status: "reported",
    source: "native-harness-telemetry",
    harness,
    receipt,
    components,
  };
  validateUsage(usage);
  return usage;
}
export function ambiguousZeroHarnessUsage(
  harness: string,
  receipt: string,
): HarnessUsage {
  const usage: HarnessUsage = {
    schema: 2,
    status: "ambiguous-zero",
    source: "native-harness-telemetry",
    harness,
    receipt,
  };
  validateUsage(usage);
  return usage;
}
export function unknownHarnessUsage(
  harness: string,
  reason: string,
): HarnessUsage {
  const usage: HarnessUsage = {
    schema: 2,
    status: "unknown",
    source: "native-harness-telemetry",
    harness,
    reason,
  };
  validateUsage(usage);
  return usage;
}

/** Strict JSON parse with duplicate-key rejection, bounded depth and a finite number grammar.
 * Duplicate keys must never alias an audited value; the accepted text is re-parsed by JSON.parse
 * only after the structural scan succeeds. */
export function parseStrictJson(text: string): unknown {
  let at = 0;
  let depth = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "!")) at++;
  };
  const str = (): void => {
    at++;
    while (at < text.length) {
      const ch = text[at];
      if (ch === "\\") {
        at += 2;
        continue;
      }
      at++;
      if (ch === '"') return;
    }
    throw new Error("strict-json-malformed");
  };
  const value = (): void => {
    ws();
    if (++depth > 64) throw new Error("strict-json-depth");
    const ch = text[at];
    if (ch === "{") {
      at++;
      ws();
      const seen = new Set<string>();
      if (text[at] !== "}")
        for (;;) {
          ws();
          if (text[at] !== '"') throw new Error("strict-json-malformed");
          const start = at;
          str();
          const key = JSON.parse(text.slice(start, at));
          if (seen.has(key)) throw new Error("strict-json-duplicate-key");
          seen.add(key);
          ws();
          if (text[at++] !== ":") throw new Error("strict-json-malformed");
          value();
          ws();
          if (text[at] !== ",") break;
          at++;
        }
      if (text[at++] !== "}") throw new Error("strict-json-malformed");
    } else if (ch === "[") {
      at++;
      ws();
      if (text[at] !== "]")
        for (;;) {
          value();
          ws();
          if (text[at] !== ",") break;
          at++;
        }
      if (text[at++] !== "]") throw new Error("strict-json-malformed");
    } else if (ch === '"') str();
    else {
      const m =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(at),
        );
      if (!m) throw new Error("strict-json-malformed");
      const number = m[0];
      if (/^-?\d/.test(number) && !Number.isFinite(Number(number)))
        throw new Error("strict-json-malformed");
      at += number.length;
    }
    depth--;
  };
  if (!text) throw new Error("strict-json-malformed");
  value();
  ws();
  if (at !== text.length) throw new Error("strict-json-malformed");
  return JSON.parse(text);
}

export interface NdjsonLimits {
  maxLineBytes: number;
  maxTotalBytes: number;
  maxFrames: number;
}
/** Bounded strict newline-delimited JSON decode: incremental fatal UTF-8 (fragmented multibyte
 * sequences across chunk boundaries decode identically), per-line and total byte bounds, a frame
 * count bound, duplicate-key rejection and no silently discarded trailing partial line. */
export class StrictNdjsonDecoder {
  #pending = Buffer.alloc(0);
  readonly frames: Json[] = [];
  readonly lines: string[] = [];
  bytes = 0;
  constructor(readonly limits: NdjsonLimits) {
    for (const key of ["maxLineBytes", "maxTotalBytes", "maxFrames"] as const)
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > 64 * 1024 * 1024
      )
        throw new Error("invalid-ndjson-limit");
    if (limits.maxLineBytes > limits.maxTotalBytes)
      throw new Error("invalid-ndjson-limit");
  }
  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limits.maxTotalBytes)
      throw new Error("strict-stream-total-limit");
    this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = this.#pending.indexOf(10)) >= 0) {
      const line = this.#pending.subarray(0, newline);
      this.#pending = this.#pending.subarray(newline + 1);
      this.#frame(line);
    }
    if (this.#pending.length > this.limits.maxLineBytes)
      throw new Error("strict-line-limit");
  }
  /** Carrier EOF: trailing partial data is a truncation, never a frame and never discarded. */
  end() {
    if (this.#pending.length) throw new Error("strict-partial-line");
  }
  #frame(line: Buffer) {
    if (line.length > this.limits.maxLineBytes)
      throw new Error("strict-line-limit");
    if (this.frames.length >= this.limits.maxFrames)
      throw new Error("strict-frame-limit");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      throw new Error("strict-invalid-utf8");
    }
    let value: unknown;
    try {
      value = parseStrictJson(text);
    } catch (error) {
      throw new Error(
        (error as Error).message === "strict-json-duplicate-key"
          ? "strict-duplicate-key"
          : "strict-malformed-frame",
      );
    }
    this.frames.push(value as Json);
    this.lines.push(text);
  }
}

/** Validate the one-shot prompt input before any spawn: exact bytes, digest, and the
 * BOM/invalid-UTF-8/empty/whitespace-only/over-limit rejections. */
export function validateAgentPrompt(
  value: string | Uint8Array,
  maxBytes: number,
): { text: string; bytes: number; sha256: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("invalid-prompt-limit");
  const buffer = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : Buffer.from(value);
  if (buffer.length === 0) throw new Error("prompt-empty");
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
    throw new Error("prompt-bom");
  if (buffer.length > maxBytes) throw new Error("prompt-over-limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("prompt-invalid-utf8");
  }
  if (typeof value === "string" && text !== value)
    throw new Error("prompt-invalid-utf8");
  if (!text.trim()) throw new Error("prompt-whitespace-only");
  return { text, bytes: buffer.length, sha256: digest(buffer) };
}

/** Host-derived staged-tree head: a canonical walk digest over names, kinds, sizes, link targets
 * and content hashes. It is the coordinator result head; a model never supplies it. */
export function deriveTreeHead(root: string, maxNodes = 100000): string {
  const entries: Json[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (entries.length >= maxNodes) throw new Error("tree-head-node-limit");
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        entries.push({ path: rel, kind: "link", target: readlinkSync(path) });
      else if (stat.isDirectory()) {
        entries.push({ path: rel, kind: "dir" });
        walk(path, rel);
      } else if (stat.isFile())
        entries.push({
          path: rel,
          kind: "file",
          bytes: stat.size,
          sha256: digest(readFileSync(path)),
        });
      else entries.push({ path: rel, kind: "other", mode: stat.mode });
    }
  };
  walk(resolve(root), "");
  return identity({ schema: "rocky-tree-head-1", entries });
}
