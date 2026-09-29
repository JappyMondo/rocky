import { canonical, type Json } from "../../store/json.js";
import type { SettlementClass } from "../seam.js";
import { CLAUDE_STRUCTURED_OUTPUT_TOOL, type ClaudeRole } from "./argv.js";
import { validateClaudeStructuredFinal } from "./final.js";

/**
 * Strict stream-json interpretation and outcome classification (CC06/CC07/CC08;
 * acceptance/claude-code manifest protocol block, source #94/879 F14–F16 and the COMPLETE /
 * SETTLED-ORDINARY / POLICY / UNRESOLVED / FATAL bindings). The documented message union is OPEN,
 * so only the reviewed allowlist below is admitted and any unknown type/subtype rejects. Frames
 * arrive from the bounded strict decoder; classification is a pure function of the observed
 * frames plus separated lifecycle facts. Exit code alone is never success evidence.
 */
export interface ClaudeExpectations {
  version: string;
  model: string;
  role: ClaudeRole;
  /** Exact approved init tools echo (role tools, plus StructuredOutput only where config-frozen;
   * G-INIT-VALUES). */
  roster: string[];
  /** Names admissible in tool_use frames: the role roster plus the synthetic StructuredOutput
   * tool that --json-schema is implemented as. Anything else is a policy denial. */
  allowedTools: string[];
  cwd: string;
  approvedSkills: string[];
  approvedSlashCommands: string[];
  maxToolUses: number;
  maxResultBytes: number;
}
export interface ClaudeLifecycleFacts {
  exitCode: number | null;
  signal: string | null;
  stdoutEof: boolean;
  stderrEof: boolean;
  childStdoutEof: boolean;
  childStderrEof: boolean;
  decoderComplete: boolean;
  transportFailure: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stderrBytes: number;
  quiescent: boolean;
}
export interface ClaudeStreamVerdict {
  /** `interrupted` is decided by the adapter from cancellation/deadline/recovery facts. */
  settlement: Exclude<SettlementClass, "interrupted">;
  reasons: string[];
  /** True only when exactly one well-formed result arrived over a clean, complete lifecycle, so
   * its telemetry can be trusted for usage mapping. */
  resolvedLifecycle: boolean;
  initObserved: boolean;
  init: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  resultRawLine: string | null;
  proposal: Json | null;
  apiRetries: Json[];
  permissionDeniedEvents: Json[];
  resultPermissionDenials: Json[];
  ordinaryFailures: { toolUseId: string; tool: string }[];
  toolUseCount: number;
  framesObserved: number;
}
const FATAL_ASSISTANT_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "model_not_found",
]);
const KNOWN_ASSISTANT_ERRORS = new Set([
  ...FATAL_ASSISTANT_ERRORS,
  "rate_limit",
  "overloaded",
  "invalid_request",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
]);
const RESULT_SUBTYPES = new Set([
  "success",
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function stringField(v: Record<string, unknown>, key: string): string | null {
  const value = v[key];
  return typeof value === "string" ? value : null;
}
function stringArray(v: Record<string, unknown>, key: string): string[] | null {
  const value = v[key];
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}
export function classifyClaudeStream(input: {
  frames: readonly Json[];
  lines: readonly string[];
  decodeError: string | null;
  lifecycle: ClaudeLifecycleFacts;
  expectations: ClaudeExpectations;
  binding: { actionKey: string; inputDigest: string };
}): ClaudeStreamVerdict {
  const fatal: string[] = [];
  const policy: string[] = [];
  const unresolved: string[] = [];
  const { expectations, lifecycle, binding } = input;
  let init: Record<string, unknown> | null = null;
  let initIndex = -1;
  let result: Record<string, unknown> | null = null;
  let resultRawLine: string | null = null;
  let resultIndexInStream = -1;
  let resultCount = 0;
  let framesAfterResult = 0;
  const apiRetries: Json[] = [];
  const permissionDeniedEvents: Json[] = [];
  const pendingToolUses = new Map<string, string>();
  const resolvedToolResults = new Set<string>();
  const erroredToolResults: { toolUseId: string; tool: string }[] = [];
  let toolUseCount = 0;
  let proposal: Json | null = null;
  let unknownFrame = false;
  const expectedRoster = [...expectations.roster].sort();
  const allowedTools = new Set(expectations.allowedTools);

  input.frames.forEach((frameValue, index) => {
    const frame = record(frameValue);
    if (!frame) {
      unresolved.push(`frame-not-object:${index}`);
      unknownFrame = true;
      return;
    }
    if (resultIndexInStream >= 0) framesAfterResult++;
    const type = stringField(frame, "type");
    const subtype = stringField(frame, "subtype");
    if (type === "system" && subtype === "init") {
      if (init) unresolved.push("multiple-init");
      else {
        init = frame;
        initIndex = index;
      }
      return;
    }
    if (type === "system" && subtype === "api_retry") {
      apiRetries.push(frameValue);
      return;
    }
    if (type === "system" && subtype === "permission_denied") {
      permissionDeniedEvents.push(frameValue);
      policy.push("system-permission-denied");
      return;
    }
    if (type === "assistant") {
      const error = stringField(frame, "error");
      if (error !== null) {
        if (FATAL_ASSISTANT_ERRORS.has(error))
          fatal.push(`assistant-error:${error}`);
        else if (KNOWN_ASSISTANT_ERRORS.has(error))
          unresolved.push(`assistant-error:${error}`);
        else unresolved.push("assistant-error-unknown");
      }
      if (frame.aborted === true) unresolved.push("assistant-aborted");
      const message = record(frame.message);
      if (!message) {
        unresolved.push("assistant-message-shape");
        return;
      }
      const messageModel = stringField(message, "model");
      if (messageModel !== null && messageModel !== expectations.model)
        unresolved.push("assistant-model-mismatch");
      const content = message.content;
      if (!Array.isArray(content)) {
        unresolved.push("assistant-content-shape");
        return;
      }
      for (const item of content) {
        const block = record(item);
        if (!block) {
          unresolved.push("unknown-content-block");
          continue;
        }
        const kind = stringField(block, "type");
        if (kind === "text" || kind === "thinking") continue;
        if (kind === "tool_use") {
          const id = stringField(block, "id");
          const name = stringField(block, "name");
          if (id === null || name === null) {
            unresolved.push("tool-use-shape");
            continue;
          }
          toolUseCount++;
          if (toolUseCount > expectations.maxToolUses) {
            unresolved.push("tool-use-limit");
            continue;
          }
          if (pendingToolUses.has(id)) unresolved.push("tool-use-id-duplicate");
          pendingToolUses.set(id, name);
          if (!allowedTools.has(name)) policy.push(`off-roster-tool:${name}`);
          continue;
        }
        unresolved.push("unknown-content-block");
      }
      return;
    }
    if (type === "user") {
      const message = record(frame.message);
      const content = message ? message.content : undefined;
      if (content === undefined && frame.tool_use_result !== undefined) return;
      if (!Array.isArray(content)) {
        unresolved.push("user-content-shape");
        return;
      }
      for (const item of content) {
        const block = record(item);
        if (!block || stringField(block, "type") !== "tool_result") {
          unresolved.push("unknown-content-block");
          continue;
        }
        const id = stringField(block, "tool_use_id");
        if (id === null) {
          unresolved.push("tool-result-shape");
          continue;
        }
        if (!pendingToolUses.has(id)) {
          unresolved.push(
            resolvedToolResults.has(id)
              ? `duplicate-tool-result:${id}`
              : `orphan-tool-result:${id}`,
          );
          continue;
        }
        const tool = pendingToolUses.get(id)!;
        pendingToolUses.delete(id);
        resolvedToolResults.add(id);
        if (block.is_error === true) {
          erroredToolResults.push({ toolUseId: id, tool });
          if (tool === CLAUDE_STRUCTURED_OUTPUT_TOOL)
            policy.push("structured-output-denied");
        }
      }
      return;
    }
    if (type === "result") {
      resultCount++;
      if (resultCount === 1) {
        result = frame;
        resultRawLine = input.lines[index] ?? null;
        resultIndexInStream = index;
      } else unresolved.push("multiple-results");
      return;
    }
    // The union is open; anything off the reviewed allowlist rejects (including every
    // observedButNotAdmittedByDefault member such as system/informational or stream_event).
    unresolved.push(
      `unknown-frame-type:${type ?? "absent"}${subtype ? `/${subtype}` : ""}`,
    );
    unknownFrame = true;
  });

  if (initIndex > 0) unresolved.push("init-not-first");
  // Typed snapshots of the callback-assigned accumulators: straight-line flow analysis only
  // sees their initializers, so the casts restore the declared observation types.
  const initFrame = init as Record<string, unknown> | null;
  const resultFrame = result as Record<string, unknown> | null;
  const resultsObserved = resultCount as number;
  const rawLine = resultRawLine as string | null;
  const afterResult = framesAfterResult as number;
  if (!initFrame) unresolved.push("init-missing");
  else {
    const sessionId = stringField(initFrame, "session_id");
    if (sessionId === null || !sessionId.trim())
      unresolved.push("init-session-blank");
    if (stringField(initFrame, "apiKeySource") !== "none")
      fatal.push("init-api-key-source");
    if (stringField(initFrame, "claude_code_version") !== expectations.version)
      fatal.push("init-version-drift");
    if (stringField(initFrame, "cwd") !== expectations.cwd)
      unresolved.push("init-cwd");
    if (stringField(initFrame, "permissionMode") !== "dontAsk")
      unresolved.push("init-permission-mode");
    if (stringField(initFrame, "model") !== expectations.model)
      unresolved.push("init-model-mismatch");
    const mcp = initFrame.mcp_servers;
    if (!Array.isArray(mcp) || mcp.length !== 0)
      unresolved.push("init-mcp-servers");
    const plugins = initFrame.plugins;
    if (!Array.isArray(plugins) || plugins.length !== 0)
      unresolved.push("init-plugins");
    const skills = stringArray(initFrame, "skills");
    if (
      skills === null ||
      !skills.every((s) => expectations.approvedSkills.includes(s))
    )
      unresolved.push("init-skills");
    const slash = stringArray(initFrame, "slash_commands");
    if (
      slash === null ||
      !slash.every((s) => expectations.approvedSlashCommands.includes(s))
    )
      unresolved.push("init-slash-commands");
    const tools = stringArray(initFrame, "tools");
    if (tools === null || tools.slice().sort().join() !== expectedRoster.join())
      unresolved.push("init-tools-roster");
  }
  for (const [id, tool] of pendingToolUses)
    unresolved.push(`tool-use-unresolved:${tool}:${id}`);
  if (afterResult > 0) unresolved.push("frame-after-result");

  let resultPermissionDenials: Json[] = [];
  if (resultsObserved === 1 && resultFrame) {
    const subtype = stringField(resultFrame, "subtype");
    const isError = resultFrame.is_error;
    if (subtype === null || !RESULT_SUBTYPES.has(subtype))
      unresolved.push("result-subtype-unknown");
    if (typeof isError !== "boolean") unresolved.push("result-is-error-shape");
    if (typeof resultFrame.startup_failure_reason === "string")
      fatal.push("startup-failure");
    const terminalReason = resultFrame.terminal_reason;
    if (
      terminalReason !== undefined &&
      terminalReason !== null &&
      terminalReason !== "completed"
    )
      unresolved.push(`terminal-reason:${String(terminalReason)}`);
    const resultIndex = resultFrame.result_index;
    if (resultIndex !== undefined && resultIndex !== null) {
      if (
        typeof resultIndex !== "number" ||
        !Number.isSafeInteger(resultIndex) ||
        Number(resultIndex) < 0
      )
        unresolved.push("result-index-shape");
      else if (Number(resultIndex) !== 0) unresolved.push("result-index-gap");
    }
    const denials = resultFrame.permission_denials;
    if (denials !== undefined && denials !== null) {
      if (!Array.isArray(denials)) unresolved.push("permission-denials-shape");
      else {
        resultPermissionDenials = denials as Json[];
        if (denials.length > 0) policy.push("result-permission-denials");
      }
    }
    const modelUsage = resultFrame.modelUsage;
    if (modelUsage !== undefined && modelUsage !== null) {
      const usageRecord = record(modelUsage);
      if (!usageRecord) fatal.push("model-usage-shape");
      else
        for (const [model, entry] of Object.entries(usageRecord)) {
          if (model !== expectations.model)
            fatal.push("model-usage-key-mismatch");
          const entryRecord = record(entry);
          const provider = entryRecord
            ? stringField(entryRecord, "provider")
            : null;
          if (provider !== "firstParty") fatal.push("model-usage-provider");
        }
    }
    if (subtype === "success") {
      if (isError === true) unresolved.push("success-with-is-error");
      if (resultFrame.structured_output === undefined)
        unresolved.push("missing-structured-output");
      else {
        try {
          proposal = validateClaudeStructuredFinal(
            resultFrame.structured_output,
            {
              actionKey: binding.actionKey,
              inputDigest: binding.inputDigest,
              role: expectations.role,
            },
          );
        } catch (error) {
          unresolved.push(
            (error as Error).message === "structured-final-binding"
              ? "structured-output-binding"
              : "structured-output-invalid",
          );
        }
      }
    } else {
      unresolved.push(`result-subtype:${subtype ?? "unknown"}`);
    }
    const resultBytes = Buffer.byteLength(canonical(resultFrame)) + 1;
    if (resultBytes > expectations.maxResultBytes)
      unresolved.push("result-bytes-limit");
  } else if (resultsObserved === 0) unresolved.push("no-result");

  // Separated lifecycle facts: EOFs, exit-code matrix, transport failure and quiescence.
  if (input.decodeError) unresolved.push(`stream-decode:${input.decodeError}`);
  if (lifecycle.signal !== null) unresolved.push("signal-observed");
  if (lifecycle.stdoutTruncated || lifecycle.stderrTruncated)
    unresolved.push("raw-capture-truncated");
  if (
    lifecycle.transportFailure &&
    lifecycle.transportFailure !== "binary-identity-drift" &&
    lifecycle.transportFailure !== "binary-identity-missing"
  )
    unresolved.push(`transport-failure:${lifecycle.transportFailure}`);
  if (!lifecycle.stdoutEof || !lifecycle.stderrEof)
    unresolved.push("carrier-eof-missing");
  if (
    !lifecycle.decoderComplete ||
    !lifecycle.childStdoutEof ||
    !lifecycle.childStderrEof
  )
    unresolved.push("stream-incomplete");
  if (!lifecycle.quiescent) unresolved.push("not-quiescent");
  if (
    lifecycle.exitCode !== null &&
    lifecycle.signal === null &&
    !lifecycle.transportFailure
  ) {
    if (resultsObserved === 1 && resultFrame) {
      const expectedExit = resultFrame.is_error === true ? 1 : 0;
      if (lifecycle.exitCode !== expectedExit)
        unresolved.push("exit-matrix-violation");
    } else if (lifecycle.exitCode === 0) unresolved.push("no-result-exit-zero");
    else if (lifecycle.stderrBytes > 0) fatal.push("startup-refusal");
    else unresolved.push("transport-closed-no-result");
  }

  const permissionDenialIds = new Set(
    resultPermissionDenials
      .map((d) => record(d))
      .filter((d): d is Record<string, unknown> => d !== null)
      .map((d) => stringField(d, "tool_use_id"))
      .filter((id): id is string => id !== null),
  );
  const ordinaryFailures = erroredToolResults.filter(
    (f) => !permissionDenialIds.has(f.toolUseId),
  );

  const settlement: ClaudeStreamVerdict["settlement"] = fatal.length
    ? "fatal"
    : policy.length
      ? "policy-denied"
      : unresolved.length || unknownFrame
        ? "unresolved"
        : "complete";
  const reasons = [...fatal, ...policy, ...unresolved];
  const resolvedLifecycle =
    resultsObserved === 1 &&
    resultFrame !== null &&
    !input.decodeError &&
    lifecycle.signal === null &&
    !lifecycle.stdoutTruncated &&
    !lifecycle.stderrTruncated &&
    !lifecycle.transportFailure &&
    lifecycle.stdoutEof &&
    lifecycle.stderrEof &&
    lifecycle.decoderComplete &&
    lifecycle.childStdoutEof &&
    lifecycle.childStderrEof &&
    lifecycle.quiescent &&
    lifecycle.exitCode !== null &&
    // The exit-code matrix must be consistent for the telemetry to count as resolved:
    // exit is 1 iff the last result carries is_error, otherwise 0.
    lifecycle.exitCode === (resultFrame?.is_error === true ? 1 : 0) &&
    afterResult === 0;
  return {
    settlement,
    reasons,
    resolvedLifecycle,
    initObserved: initFrame !== null,
    init: initFrame,
    result: resultFrame,
    resultRawLine: rawLine,
    proposal,
    apiRetries,
    permissionDeniedEvents,
    resultPermissionDenials,
    ordinaryFailures,
    toolUseCount,
    framesObserved: input.frames.length,
  };
}
