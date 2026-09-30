import { execFile, type ChildProcess } from "node:child_process";
import { retainImmutable } from "./retention.js";
import { digest } from "../../store/json.js";
import { parseStrictJson } from "../seam.js";
import type { SealedEnv } from "../seam.js";

/**
 * Post-run `opencode export <sessionID>` audit — the REQUIRED success conjunct (#104 research
 * F25, PART 4 §2). The live stream carries NO result/done event, no served-model echo and no
 * aggregate usage frame, so after physical quiescence the adapter spawns a second bounded child
 * (same pinned binary, same sealed env, same isolated OPENCODE_DB) and strictly parses the
 * exported session JSON. Pinned output shape (source cli/cmd/export.ts:run — JSON.stringify of
 * `{info: SessionInfo, messages: Message.WithParts[]}`, pretty-printed, stdout-only; the
 * "Exporting session" banner goes to stderr):
 *   info: {id, version, directory, model?{id, providerID}, tokens?{input,output,reasoning,cache}}
 *   messages[].info (assistant): {role, modelID, providerID, tokens{input,output,reasoning,
 *                                 cache{read,write}}, error?}
 * Audit failures are classified: export unavailable (spawn/timeout/nonzero-exit/parse/shape/
 * missing session) makes the attempt UNRESOLVED with unknown usage — NEVER success; a served
 * model/provider/version/directory mismatch is FATAL (PART 4 §3); an aggregate-vs-step_finish
 * token divergence makes usage unknown only (PART 4 §5, G-USAGE-COMPONENTS open).
 * Evidence-about-the-run: this is not part of the run stream and never re-launches the run.
 */
export interface OpencodeExportExpectations {
  sessionId: string;
  version: string;
  directory: string;
  providerID: string;
  modelID: string;
  /** SUM of step_finish tokens over the run stream, or null when absent. */
  summedTokens: { input: number; output: number } | null;
}
export interface OpencodeExportAggregate {
  input: number;
  output: number;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}
export type OpencodeExportAudit =
  | {
      ok: true;
      rawSha256: string;
      rawBytes: number;
      assistantMessages: number;
      aggregate: OpencodeExportAggregate;
      /** Present when the export aggregate disagrees with SessionInfo.tokens or the summed
       * step_finish telemetry; usage becomes unknown, the settlement may stay complete. */
      divergence: string | null;
    }
  | {
      ok: false;
      /** Fatal mismatches (served identity) vs unavailable evidence (everything else). */
      fatal: boolean;
      reason: string;
      rawSha256: string | null;
      rawBytes: number;
    };
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function finiteCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  // The pinned schema types token counts as finite numbers; schema-2 usage requires integers, so
  // a fractional or negative count is invalid telemetry, never a reported value.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return null;
  return value;
}
function unavailable(reason: string, raw: string | null): OpencodeExportAudit {
  return {
    ok: false,
    fatal: false,
    reason,
    rawSha256: raw === null ? null : digest(Buffer.from(raw, "utf8")),
    rawBytes: raw === null ? 0 : Buffer.byteLength(raw, "utf8"),
  };
}
function mismatch(reason: string, raw: string | null): OpencodeExportAudit {
  return {
    ok: false,
    fatal: true,
    reason,
    rawSha256: raw === null ? null : digest(Buffer.from(raw, "utf8")),
    rawBytes: raw === null ? 0 : Buffer.byteLength(raw, "utf8"),
  };
}
/** Spawn the bounded export child and audit it. Never throws: every failure mode is a classified
 * unavailable/fatal result, and an unavailable audit is never success. Raw stdout bytes (when any
 * were produced) are retained 0600 at retainPath — the usage receipt digest references them. */
export async function runOpencodeExportAudit(input: {
  binaryPath: string;
  env: SealedEnv;
  cwd: string;
  timeoutMs: number;
  maxExportBytes: number;
  retainPath: string;
  expectations: OpencodeExportExpectations;
  start: (launch: () => ChildProcess) => ChildProcess;
  signal?: AbortSignal;
}): Promise<OpencodeExportAudit> {
  // Only synchronous process creation occurs inside the Store fence, never the async wait.
  const observed = await new Promise<{ raw: string; error: Error | null }>(
    (resolve) => {
      try {
        input.start(() =>
          execFile(
            input.binaryPath,
            ["export", input.expectations.sessionId],
            {
              cwd: input.cwd,
              env: Object.fromEntries(input.env),
              encoding: "utf8",
              timeout: input.timeoutMs,
              maxBuffer: input.maxExportBytes,
              ...(input.signal ? { signal: input.signal } : {}),
            },
            (error, stdout) =>
              resolve({ raw: typeof stdout === "string" ? stdout : "", error }),
          ),
        );
      } catch (error) {
        resolve({ raw: "", error: error as Error });
      }
    },
  );
  if (!retainRaw(input.retainPath, observed.raw))
    return unavailable("export-retention-failed", observed.raw);
  if (observed.error) {
    const e = observed.error as Error & {
      code?: number | string;
      killed?: boolean;
    };
    const reason = e.message.includes("maxBuffer")
      ? "export-bytes-limit"
      : e.name === "AbortError"
        ? "export-aborted"
        : e.killed
          ? "export-timeout"
          : `export-spawn-failed:${typeof e.code === "number" ? e.code : "signal-or-error"}`;
    return unavailable(reason, observed.raw);
  }
  if (Buffer.byteLength(observed.raw, "utf8") > input.maxExportBytes)
    return unavailable("export-bytes-limit", observed.raw);
  return auditOpencodeExport(observed.raw, input.expectations);
}
function retainRaw(path: string, raw: string | null): boolean {
  if (raw === null) return false;
  try {
    retainImmutable(path, raw);
    return true;
  } catch {
    return false;
  }
}
/** Pure strict audit of export stdout bytes (split out for direct testing). */
export function auditOpencodeExport(
  raw: string,
  expectations: OpencodeExportExpectations,
): OpencodeExportAudit {
  if (!raw.trim()) return unavailable("export-empty", raw);
  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw);
  } catch (error) {
    return unavailable(`export-malformed:${(error as Error).message}`, raw);
  }
  const top = record(parsed);
  if (!top) return unavailable("export-shape:top", raw);
  const keys = Object.keys(top).sort();
  if (keys.join() !== ["info", "messages"].join())
    return unavailable("export-shape:top-keys", raw);
  const info = record(top.info);
  if (!info) return unavailable("export-shape:info", raw);
  const messages = top.messages;
  if (!Array.isArray(messages))
    return unavailable("export-shape:messages", raw);
  // Session identity: the export must be the audited session.
  if (info.id !== expectations.sessionId)
    return unavailable("export-session-mismatch", raw);
  // Served identity mismatches are FATAL (PART 4 §3): version echo vs pin, directory vs SRC.
  if (info.version !== expectations.version)
    return mismatch("export-version-mismatch", raw);
  if (info.directory !== expectations.directory)
    return mismatch("export-directory-mismatch", raw);
  const sessionModel = record(info.model);
  if (sessionModel) {
    if (
      sessionModel.providerID !== expectations.providerID ||
      sessionModel.id !== expectations.modelID
    )
      return mismatch("export-session-model-mismatch", raw);
  }
  let assistantMessages = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawReasoning = false;
  let sawCache = false;
  for (const entry of messages) {
    const message = record(entry);
    if (!message) return unavailable("export-shape:message", raw);
    const mInfo = record(message.info);
    if (!mInfo) return unavailable("export-shape:message-info", raw);
    if (!Array.isArray(message.parts))
      return unavailable("export-shape:message-parts", raw);
    if (mInfo.role === "user") continue;
    if (mInfo.role !== "assistant")
      return unavailable(
        `export-shape:message-role:${String(mInfo.role)}`,
        raw,
      );
    assistantMessages++;
    if (
      mInfo.modelID !== expectations.modelID ||
      mInfo.providerID !== expectations.providerID
    )
      return mismatch("export-assistant-model-mismatch", raw);
    if (mInfo.error !== undefined && mInfo.error !== null)
      // A session error the live stream never emitted is a stream/export divergence; fail closed.
      return mismatch("export-assistant-error", raw);
    const tokens = record(mInfo.tokens);
    if (!tokens) return unavailable("export-shape:assistant-tokens", raw);
    const t = {
      input: finiteCount(tokens.input),
      output: finiteCount(tokens.output),
      reasoning: finiteCount(tokens.reasoning),
      read: finiteCount(record(tokens.cache)?.read),
      write: finiteCount(record(tokens.cache)?.write),
    };
    if (t.input === null || t.output === null)
      return unavailable("export-tokens-invalid", raw);
    input += t.input;
    output += t.output;
    if (t.reasoning !== null) {
      reasoning += t.reasoning;
      sawReasoning = true;
    }
    if (t.read !== null && t.write !== null) {
      cacheRead += t.read;
      cacheWrite += t.write;
      sawCache = true;
    } else if (tokens.cache !== undefined)
      return unavailable("export-cache-shape", raw);
  }
  if (assistantMessages === 0)
    // A run that served no assistant message cannot corroborate the stream; never success.
    return unavailable("export-no-assistant-messages", raw);
  const aggregate: OpencodeExportAggregate = {
    input,
    output,
    reasoning: sawReasoning ? reasoning : null,
    cacheRead: sawCache ? cacheRead : null,
    cacheWrite: sawCache ? cacheWrite : null,
  };
  let divergence: string | null = null;
  // SessionInfo.tokens (optional aggregate) must agree with the assistant-message sum.
  const infoTokens = record(info.tokens);
  if (infoTokens) {
    const it = {
      input: finiteCount(infoTokens.input),
      output: finiteCount(infoTokens.output),
    };
    if (it.input === null || it.output === null)
      divergence = "session-tokens-invalid";
    else if (it.input !== input || it.output !== output)
      divergence = "session-tokens-divergent";
  }
  // Cross-check against the summed step_finish telemetry from the live stream (PART 4 §2/§5).
  if (!divergence && expectations.summedTokens) {
    if (
      expectations.summedTokens.input !== input ||
      expectations.summedTokens.output !== output
    )
      divergence = "step-finish-aggregate-divergent";
  }
  return {
    ok: true,
    rawSha256: digest(Buffer.from(raw, "utf8")),
    rawBytes: Buffer.byteLength(raw, "utf8"),
    assistantMessages,
    aggregate,
    divergence,
  };
}
