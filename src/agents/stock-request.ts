import { canonical, type Json } from "../store/json.js";
import { object, integer } from "../coordinator/contracts.js";
import {
  exact,
  gatewayLimits,
  sha256,
  type FrozenRequest,
  type ProviderRecord,
} from "./provider-ledger.js";

export type StockContract = {
  version: "stock-responses-v1";
  invocation: string;
  actionKey: string;
  inputDigest: string;
  head: string;
  role: "implementer" | "reviewer";
  purpose: "restricted" | "retained-compatibility";
  identities: {
    binary: string;
    source: string;
    schema: string;
    config: string;
  };
  profile: Record<string, Json>;
  turns: { id: string; input: Json[] }[];
  correlation: {
    thread: string;
    session: string;
    window: string;
    installation: string;
    workspace: string;
  };
  headers: { originator: string; userAgent: string; beta: string };
  outputCap: number;
};
export type StockCompletion = {
  responseId: string;
  items: Record<string, Json>[];
  cachedInput: number | null;
  reasoning: number | null;
};
export type StockRecord = {
  contractDigest: string;
  ordinal: number;
  turn: string;
  parent: string | null;
  progression: string;
  wireDigest: string;
  headersDigest: string;
  response: StockCompletion | null;
  forwarding: "pending" | "sending" | "finished";
};
export function string(value: unknown, max = 65536): asserts value is string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new Error("stock-string");
}
export function identifier(value: unknown): asserts value is string {
  string(value, 256);
  if (!/^[a-zA-Z0-9_:/.-]{1,256}$/.test(value)) throw new Error("stock-id");
}
export function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
) {
  const v = object(value);
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    throw new Error("stock-fields");
  return v;
}
const profileFields = [
  "model",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "text",
];
function localSchema(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("stock-schema-depth");
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["$ref", "$dynamicRef", "$id"].includes(key))
        throw new Error("stock-schema-reference");
      localSchema(child, depth + 1);
    }
  }
}
export function stockProfile(
  value: unknown,
  purpose: StockContract["purpose"],
) {
  const v = exact(value, profileFields);
  const reasoning = exact(v.reasoning, ["effort"]);
  if (
    !(
      (v.model === "gpt-6-sol" && reasoning.effort === "medium") ||
      (v.model === "gpt-6-astra" && reasoning.effort === "high")
    )
  )
    throw new Error("stock-model-effort");
  string(v.instructions, 128 * 1024);
  if (
    v.tool_choice !== "auto" ||
    typeof v.parallel_tool_calls !== "boolean" ||
    v.stream !== true ||
    v.store !== false ||
    canonical(v.include) !== canonical(["reasoning.encrypted_content"])
  )
    throw new Error("stock-profile");
  const text = exact(v.text, ["verbosity", "format"]),
    format = exact(text.format, ["type", "strict", "schema", "name"]);
  if (
    !["low", "medium", "high"].includes(String(text.verbosity)) ||
    typeof text.verbosity !== "string" ||
    format.type !== "json_schema" ||
    format.strict !== true
  )
    throw new Error("stock-output-schema");
  identifier(format.name);
  object(format.schema);
  localSchema(format.schema);
  if (!Array.isArray(v.tools) || v.tools.length > 32)
    throw new Error("stock-tools");
  const names = new Set<string>();
  for (const item of v.tools) {
    const tool = object(item);
    identifier(tool.name);
    string(tool.description, 32768);
    if (names.has(tool.name)) throw new Error("stock-tools");
    names.add(tool.name);
    if (tool.type === "function") {
      exact(tool, ["type", "name", "description", "strict", "parameters"]);
      if (
        ![
          "exec_command",
          "write_stdin",
          ...(purpose === "retained-compatibility" ? ["view_image"] : []),
        ].includes(tool.name) ||
        typeof tool.strict !== "boolean"
      )
        throw new Error("stock-tool-unavailable");
      const schema = exact(tool.parameters, [
        "type",
        "properties",
        "required",
        "additionalProperties",
      ]);
      if (
        schema.type !== "object" ||
        schema.additionalProperties !== false ||
        !Array.isArray(schema.required)
      )
        throw new Error("stock-tool-schema");
      localSchema(schema);
      object(schema.properties);
    } else if (tool.type === "custom") {
      exact(tool, ["type", "name", "description", "format"]);
      const grammar = exact(tool.format, ["type", "syntax", "definition"]);
      if (
        tool.name !== "apply_patch" ||
        grammar.type !== "grammar" ||
        grammar.syntax !== "lark"
      )
        throw new Error("stock-custom-tool");
      string(grammar.definition, 65536);
    } else throw new Error("stock-server-tool");
  }
  return v;
}
function message(value: unknown, initial = false) {
  const v = fields(value, ["type", "role", "content"], ["id"]);
  if (
    v.type !== "message" ||
    typeof v.role !== "string" ||
    !["developer", "user", "assistant"].includes(v.role) ||
    !Array.isArray(v.content) ||
    v.content.length < 1 ||
    v.content.length > 64
  )
    throw new Error("stock-message");
  if (v.id !== undefined) {
    identifier(v.id);
    if (initial && !v.id.startsWith("msg_"))
      throw new Error("stock-message-id");
  }
  for (const p of v.content) {
    const part = exact(p, ["type", "text"]);
    if (part.type !== (v.role === "assistant" ? "output_text" : "input_text"))
      throw new Error("stock-content-unsupported");
    string(part.text, gatewayLimits.requestBytes);
  }
  return v;
}
function initialProjection(input: unknown) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 256)
    throw new Error("stock-initial-input");
  return input.map((item) => {
    const v = message(item, true);
    if (v.role === "assistant") throw new Error("stock-initial-role");
    const { id, ...projection } = v;
    return projection;
  });
}
export function freezeStockContract(value: StockContract): StockContract {
  if (Buffer.byteLength(canonical(value)) > gatewayLimits.requestBytes)
    throw new Error("stock-contract-limit");
  const c = exact(value, [
    "version",
    "invocation",
    "actionKey",
    "inputDigest",
    "head",
    "role",
    "purpose",
    "identities",
    "profile",
    "turns",
    "correlation",
    "headers",
    "outputCap",
  ]);
  if (
    c.version !== "stock-responses-v1" ||
    !["implementer", "reviewer"].includes(String(c.role)) ||
    !["restricted", "retained-compatibility"].includes(String(c.purpose)) ||
    typeof c.role !== "string" ||
    typeof c.purpose !== "string"
  )
    throw new Error("stock-contract-version");
  for (const k of ["invocation", "actionKey", "inputDigest", "head"])
    identifier(c[k]);
  Object.values(
    exact(c.identities, ["binary", "source", "schema", "config"]),
  ).forEach(identifier);
  Object.values(
    exact(c.correlation, [
      "thread",
      "session",
      "window",
      "installation",
      "workspace",
    ]),
  ).forEach((v) => string(v, 2048));
  const h = exact(c.headers, ["originator", "userAgent", "beta"]);
  Object.values(h).forEach((v) => string(v, 1024));
  stockProfile(c.profile, value.purpose);
  integer(c.outputCap, 1);
  if (!Array.isArray(c.turns) || c.turns.length < 1 || c.turns.length > 16)
    throw new Error("stock-turns");
  const ids = new Set<string>();
  for (const turn of c.turns) {
    const t = exact(turn, ["id", "input"]);
    identifier(t.id);
    if (ids.has(t.id)) throw new Error("stock-turns");
    ids.add(t.id);
    initialProjection(t.input);
  }
  return JSON.parse(canonical(value));
}
const metadataFields = [
  "installation_id",
  "session_id",
  "thread_id",
  "agent_name",
  "turn_id",
  "window_id",
  "window_number",
  "context_window_id",
  "request_kind",
  "root_turn_id",
  "sandbox",
  "sandbox_mode",
  "auto_review_enabled",
  "node_repl_auto_review_required",
  "node_repl_disabled",
  "turn_started_at_unix_ms",
  "analytics_enabled",
  "model",
  "reasoning_effort",
];
function metadata(value: unknown, c: StockContract, turn: string) {
  string(value, 8192);
  const m = fields(strictJson(Buffer.from(value)), metadataFields, [
    "workspaces",
  ]);
  const pinned = {
    installation_id: c.correlation.installation,
    session_id: c.correlation.session,
    thread_id: c.correlation.thread,
    turn_id: turn,
    root_turn_id: c.turns[0]!.id,
    window_id: c.correlation.window,
    request_kind: "turn",
    model: c.profile.model,
    reasoning_effort: object(c.profile.reasoning).effort,
  };
  for (const [key, v] of Object.entries(pinned))
    if (m[key] !== v) throw new Error("stock-correlation");
  for (const key of [
    "agent_name",
    "context_window_id",
    "sandbox",
    "sandbox_mode",
  ])
    string(m[key], 256);
  for (const key of ["window_number", "turn_started_at_unix_ms"])
    integer(m[key]);
  for (const key of [
    "auto_review_enabled",
    "node_repl_auto_review_required",
    "node_repl_disabled",
    "analytics_enabled",
  ])
    if (typeof m[key] !== "boolean") throw new Error("stock-metadata");
  if (m.workspaces !== undefined) {
    const w = exact(m.workspaces, [c.correlation.workspace]),
      entry = exact(w[c.correlation.workspace], [
        "latest_git_commit_hash",
        "has_changes",
      ]);
    if (
      typeof entry.latest_git_commit_hash !== "string" ||
      !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.latest_git_commit_hash) ||
      typeof entry.has_changes !== "boolean"
    )
      throw new Error("stock-workspace-metadata");
  }
}
export const stockHeaders = [
  "x-codex-beta-features",
  "x-codex-window-id",
  "x-codex-turn-metadata",
  "x-client-request-id",
  "session-id",
  "thread-id",
  "accept",
  "originator",
  "user-agent",
];
export function validateStockHeaders(
  headers: Record<string, unknown>,
  c: StockContract,
  turn: string,
) {
  const fixed = {
    "x-codex-beta-features": c.headers.beta,
    "x-codex-window-id": c.correlation.window,
    "session-id": c.correlation.session,
    "thread-id": c.correlation.thread,
    accept: "text/event-stream",
    originator: c.headers.originator,
    "user-agent": c.headers.userAgent,
  };
  for (const [key, v] of Object.entries(fixed))
    if (headers[key] !== v) throw new Error("stock-header");
  identifier(headers["x-client-request-id"]);
  metadata(headers["x-codex-turn-metadata"], c, turn);
}
export function strictJson(bytes: Buffer): unknown {
  // Reject duplicate property names too: they must not alias an audited initial profile/history.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0,
    depth = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "!")) at++;
  };
  const str = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error("stock-json");
  };
  const value = (): void => {
    ws();
    if (++depth > 40) throw new Error("stock-json-depth");
    const ch = text[at];
    if (ch === "{") {
      at++;
      ws();
      const keys = new Set();
      if (text[at] !== "}")
        for (;;) {
          ws();
          if (text[at] !== '"') throw new Error("stock-json");
          const k = str();
          if (keys.has(k)) throw new Error("stock-json-duplicate");
          keys.add(k);
          ws();
          if (text[at++] !== ":") throw new Error("stock-json");
          value();
          ws();
          if (text[at] !== ",") break;
          at++;
        }
      if (text[at++] !== "}") throw new Error("stock-json");
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
      if (text[at++] !== "]") throw new Error("stock-json");
    } else if (ch === '"') str();
    else {
      const m =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(at),
        );
      if (!m) throw new Error("stock-json");
      at += m[0].length;
    }
    depth--;
  };
  value();
  ws();
  if (at !== text.length) throw new Error("stock-json");
  return JSON.parse(text);
}
export function validateStockCall(value: unknown, c: StockContract) {
  const v = object(value);
  const custom = v.type === "custom_tool_call";
  fields(
    v,
    ["type", "call_id", "name", custom ? "input" : "arguments"],
    ["id", "status"],
  );
  if (
    typeof v.type !== "string" ||
    !["function_call", "custom_tool_call"].includes(v.type)
  )
    throw new Error("stock-call-type");
  identifier(v.call_id);
  identifier(v.name);
  if (v.id !== undefined) identifier(v.id);
  if (v.status !== undefined && v.status !== "completed")
    throw new Error("stock-call-status");
  const tool = (c.profile.tools as Record<string, Json>[]).find(
    (t) => t.name === v.name && t.type === (custom ? "custom" : "function"),
  );
  if (!tool) throw new Error("stock-call-tool");
  string(v[custom ? "input" : "arguments"], 65536);
  if (!custom) {
    const args = object(strictJson(Buffer.from(v.arguments as string))),
      parameters = object(tool.parameters),
      props = object(parameters.properties);
    for (const key of parameters.required as string[])
      if (!Object.hasOwn(args, key)) throw new Error("stock-arguments");
    for (const [key, val] of Object.entries(args)) {
      if (
        key === "login" &&
        v.name === "exec_command" &&
        c.purpose === "retained-compatibility" &&
        val === false
      )
        continue;
      const schema = object(props[key]);
      const type = schema.type;
      if (type === "array") {
        if (
          !Array.isArray(val) ||
          val.length > 64 ||
          val.some((x) => typeof x !== "string")
        )
          throw new Error("stock-arguments");
      } else if (
        typeof val !== type ||
        (type === "number" && !Number.isFinite(val))
      )
        throw new Error("stock-arguments");
      if (
        schema.enum !== undefined &&
        !(schema.enum as unknown[]).includes(val)
      )
        throw new Error("stock-arguments");
    }
  }
  return v as Record<string, Json>;
}
export function validateStockOutputItem(value: unknown, c: StockContract) {
  const v = object(value);
  if (v.type === "message") {
    message(v);
    if (v.role !== "assistant") throw new Error("stock-output-role");
    identifier(v.id);
    return v as Record<string, Json>;
  }
  return validateStockCall(v, c);
}
export function freezeStockRequest(
  body: unknown,
  c: StockContract,
): { request: FrozenRequest; turn: string; input: Record<string, Json>[] } {
  const v = exact(body, [
    ...profileFields,
    "input",
    "prompt_cache_key",
    "client_metadata",
  ]);
  if (Buffer.byteLength(canonical(v)) > gatewayLimits.requestBytes)
    throw new Error("stock-body-limit");
  if (
    canonical(Object.fromEntries(profileFields.map((k) => [k, v[k]]))) !==
    canonical(c.profile)
  )
    throw new Error("stock-profile-drift");
  if (v.prompt_cache_key !== c.correlation.thread)
    throw new Error("stock-cache-key");
  const m = exact(v.client_metadata, [
    "turn_id",
    "thread_id",
    "root_turn_id",
    "x-codex-turn-metadata",
    "x-codex-installation-id",
    "x-codex-window-id",
    "session_id",
  ]);
  identifier(m.turn_id);
  const turn = m.turn_id;
  if (!c.turns.some((t) => t.id === turn))
    throw new Error("stock-turn-unapproved");
  const pinned = {
    thread_id: c.correlation.thread,
    root_turn_id: c.turns[0]!.id,
    "x-codex-installation-id": c.correlation.installation,
    "x-codex-window-id": c.correlation.window,
    session_id: c.correlation.session,
  };
  for (const [k, x] of Object.entries(pinned))
    if (m[k] !== x) throw new Error("stock-correlation");
  metadata(m["x-codex-turn-metadata"], c, turn);
  if (!Array.isArray(v.input) || v.input.length < 1 || v.input.length > 256)
    throw new Error("stock-history-limit");
  const ids = new Set<string>();
  for (const item of v.input) {
    const p = object(item);
    if (p.id !== undefined) {
      identifier(p.id);
      if (ids.has(p.id)) throw new Error("stock-duplicate-item");
      ids.add(p.id);
    }
    if (p.type === "message") message(p);
    else if (["function_call", "custom_tool_call"].includes(String(p.type)))
      validateStockCall(p, c);
    else if (
      ["function_call_output", "custom_tool_call_output"].includes(
        String(p.type),
      )
    ) {
      fields(p, ["type", "call_id", "output"], ["id"]);
      identifier(p.call_id);
      string(p.output, gatewayLimits.requestBytes);
    } else throw new Error("stock-history-unsupported");
  }
  const frozen = canonical(v);
  return {
    request: Object.freeze({
      body: frozen,
      digest: sha256(frozen),
      model: c.profile.model as FrozenRequest["model"],
      effort: object(c.profile.reasoning).effort as FrozenRequest["effort"],
      images: Object.freeze([]),
      protocol: "stock-responses-v1",
    }),
    turn,
    input: v.input as Record<string, Json>[],
  };
}
export function stockProgression(
  c: StockContract,
  input: Record<string, Json>[],
  turn: string,
  previous: ProviderRecord | undefined,
) {
  if (!previous) {
    if (
      turn !== c.turns[0]!.id ||
      canonical(initialProjection(input)) !==
        canonical(initialProjection(c.turns[0]!.input))
    )
      throw new Error("stock-initial-mismatch");
    return `initial/${turn}`;
  }
  const prior = previous.stock;
  if (
    previous.state !== "completed" ||
    !prior?.response ||
    prior.forwarding !== "finished"
  )
    throw new Error("stock-history-unresolved");
  const old = object(JSON.parse(previous.request.body)).input as Record<
    string,
    Json
  >[];
  if (canonical(input.slice(0, old.length)) !== canonical(old))
    throw new Error("stock-history-rewrite");
  const extra = input.slice(old.length),
    items = prior.response.items;
  const calls = items.filter((v) => v.type !== "message");
  if (calls.length) {
    if (
      turn !== prior.turn ||
      calls.length !== items.length ||
      extra.length !== calls.length * 2
    )
      throw new Error("stock-result-progression");
    for (let n = 0; n < calls.length; n++) {
      const expected = calls[n]!,
        call = extra[n * 2]!,
        output = extra[n * 2 + 1]!;
      let normalized = { ...call };
      if (expected.id === undefined && call.id !== undefined) {
        if (
          expected.type !== "function_call" ||
          typeof call.id !== "string" ||
          !call.id.startsWith("fc_")
        )
          throw new Error("stock-native-id");
        delete normalized.id;
      }
      if (
        canonical(normalized) !== canonical(expected) ||
        output.type !==
          (expected.type === "function_call"
            ? "function_call_output"
            : "custom_tool_call_output") ||
        output.call_id !== expected.call_id
      )
        throw new Error("stock-result-mismatch");
      if (
        output.id !== undefined &&
        (expected.type !== "function_call" ||
          typeof output.id !== "string" ||
          !output.id.startsWith("fco_"))
      )
        throw new Error("stock-native-id");
    }
    return `results/${previous.id}`;
  }
  const index = c.turns.findIndex((t) => t.id === prior.turn),
    next = c.turns[index + 1];
  if (
    !next ||
    next.id !== turn ||
    canonical(extra.slice(0, items.length)) !== canonical(items) ||
    canonical(initialProjection(extra.slice(items.length))) !==
      canonical(initialProjection(next.input))
  )
    throw new Error("stock-turn-progression");
  return `turn/${turn}/${previous.id}`;
}
