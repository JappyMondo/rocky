import { canonical } from "../store/json.js";
import { integer, object } from "../coordinator/contracts.js";
import {
  gatewayLimits,
  sha256,
  type ProviderRecord,
} from "./provider-ledger.js";
import {
  fields,
  identifier,
  string,
  strictJson,
  validateStockOutputItem,
  type StockCompletion,
  type StockContract,
} from "./stock-request.js";

/** Whole-response observation only. No tool bytes leave the gateway before durable accounting. */
export async function readStockResponse(
  stream: AsyncIterable<Uint8Array>,
  contract: StockContract,
  input: number,
  cap: number,
  signal: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("stock-response-aborted");
    bytes += chunk.byteLength;
    if (bytes > gatewayLimits.responseBytes)
      throw new Error("stock-response-limit");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks, bytes),
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(raw)
      .replaceAll("\r\n", "\n");
  if (text.includes("\r") || !text.endsWith("\n\n"))
    throw new Error("stock-sse-incomplete");
  const frames = text.slice(0, -2).split("\n\n");
  if (frames.length > gatewayLimits.events)
    throw new Error("stock-event-limit");
  let responseId: string | undefined,
    terminal: "completed" | "incomplete" | undefined,
    usage: ProviderRecord["usage"] = null;
  const items: StockCompletion["items"] = [],
    ids = new Set<string>(),
    calls = new Set<string>();
  let cachedInput: number | null = null,
    reasoning: number | null = null;
  // Added/delta state is source-derived, not required for the retained done-only native exchange.
  const added = new Map<number, Record<string, unknown>>(),
    deltas = new Map<string, string>();
  let sequence = -1;
  for (const frame of frames) {
    if (Buffer.byteLength(frame) > gatewayLimits.eventBytes)
      throw new Error("stock-event-limit");
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const at = line.indexOf(":"),
        name = at < 0 ? line : line.slice(0, at);
      let value = at < 0 ? "" : line.slice(at + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "data") data.push(value);
      else if (name === "event" && event === undefined) event = value;
      else throw new Error("stock-sse-field");
    }
    if (!data.length) {
      if (event !== undefined) throw new Error("stock-sse-empty-event");
      continue;
    }
    if (terminal) throw new Error("stock-post-terminal");
    const v = object(strictJson(Buffer.from(data.join("\n"))));
    identifier(v.type);
    if (event !== undefined && event !== v.type)
      throw new Error("stock-event-mismatch");
    if (v.sequence_number !== undefined) {
      integer(v.sequence_number);
      if (v.sequence_number <= sequence) throw new Error("stock-event-order");
      sequence = v.sequence_number;
    }
    const index = () => {
      integer(v.output_index);
      return Number(v.output_index);
    };
    if (v.type === "response.created") {
      fields(v, ["type", "response"], ["sequence_number"]);
      if (responseId !== undefined) throw new Error("stock-created-duplicate");
      const r = fields(v.response, ["id"], ["model", "status", "error"]);
      identifier(r.id);
      responseId = r.id;
      if (
        (r.model !== undefined && r.model !== contract.profile.model) ||
        (r.status !== undefined && r.status !== "in_progress") ||
        (r.error !== undefined && r.error !== null)
      )
        throw new Error("stock-created");
    } else if (v.type === "response.output_item.added") {
      fields(v, ["type", "item", "output_index"], ["sequence_number"]);
      if (!responseId) throw new Error("stock-before-created");
      const i = index();
      if (i !== items.length || added.has(i))
        throw new Error("stock-item-order");
      const item = object(v.item);
      identifier(item.id);
      if (item.type !== "message") throw new Error("stock-added-unsupported");
      fields(item, ["id", "type", "role", "content"], ["status"]);
      if (
        item.role !== "assistant" ||
        canonical(item.content) !== "[]" ||
        (item.status !== undefined && item.status !== "in_progress")
      )
        throw new Error("stock-added-shape");
      added.set(i, item);
    } else if (v.type === "response.output_text.delta") {
      fields(
        v,
        ["type", "item_id", "output_index", "content_index", "delta"],
        ["sequence_number"],
      );
      const i = index(),
        item = added.get(i);
      if (!item || item.id !== v.item_id || v.content_index !== 0)
        throw new Error("stock-delta-causality");
      string(v.delta, gatewayLimits.eventBytes);
      const previous = deltas.get(String(v.item_id)) ?? "";
      deltas.set(String(v.item_id), previous + v.delta);
    } else if (v.type === "response.output_item.done") {
      fields(v, ["type", "item"], ["output_index", "sequence_number"]);
      if (!responseId) throw new Error("stock-before-created");
      if (v.output_index !== undefined && index() !== items.length)
        throw new Error("stock-item-order");
      const item = validateStockOutputItem(v.item, contract);
      const announced = added.get(items.length);
      if (announced) {
        if (
          item.id !== announced.id ||
          item.type !== announced.type ||
          item.role !== announced.role
        )
          throw new Error("stock-done-mismatch");
        const content = item.content as { text: string }[];
        if (
          content.length !== 1 ||
          content[0]!.text !== (deltas.get(String(item.id)) ?? "")
        )
          throw new Error("stock-delta-mismatch");
        added.delete(items.length);
      }
      if (item.id !== undefined) {
        identifier(item.id);
        if (ids.has(item.id)) throw new Error("stock-duplicate-item");
        ids.add(item.id);
      }
      if (item.call_id !== undefined) {
        identifier(item.call_id);
        if (calls.has(item.call_id)) throw new Error("stock-duplicate-call");
        calls.add(item.call_id);
      }
      if (items.length >= 64) throw new Error("stock-item-limit");
      items.push(item);
    } else if (
      v.type === "response.completed" ||
      v.type === "response.incomplete"
    ) {
      fields(v, ["type", "response"], ["sequence_number"]);
      const r = fields(
        v.response,
        ["id", "usage"],
        ["model", "status", "error", "output", "incomplete_details"],
      );
      terminal = v.type === "response.completed" ? "completed" : "incomplete";
      if (
        !responseId ||
        r.id !== responseId ||
        added.size ||
        !items.length ||
        (r.model !== undefined && r.model !== contract.profile.model) ||
        (r.status !== undefined && r.status !== terminal) ||
        (r.error !== undefined && r.error !== null) ||
        (r.output !== undefined && canonical(r.output) !== canonical(items))
      )
        throw new Error("stock-terminal");
      if (r.incomplete_details !== undefined) {
        if (terminal !== "incomplete")
          throw new Error("stock-incomplete-details");
        const d = fields(r.incomplete_details, ["reason"]);
        if (d.reason !== "max_output_tokens")
          throw new Error("stock-incomplete-details");
      }
      const u = fields(
        r.usage,
        ["input_tokens", "output_tokens", "total_tokens"],
        ["input_tokens_details", "output_tokens_details"],
      );
      for (const key of ["input_tokens", "output_tokens", "total_tokens"])
        integer(u[key]);
      if (
        u.input_tokens !== input ||
        Number(u.output_tokens) > cap ||
        u.total_tokens !== Number(u.input_tokens) + Number(u.output_tokens)
      )
        throw new Error("stock-usage");
      if (u.input_tokens_details !== undefined) {
        const d = fields(u.input_tokens_details, ["cached_tokens"]);
        integer(d.cached_tokens);
        if (d.cached_tokens > input) throw new Error("stock-cache-usage");
        cachedInput = d.cached_tokens;
      }
      if (u.output_tokens_details !== undefined) {
        const d = fields(u.output_tokens_details, ["reasoning_tokens"]);
        integer(d.reasoning_tokens);
        if (d.reasoning_tokens > Number(u.output_tokens))
          throw new Error("stock-reasoning-usage");
        reasoning = d.reasoning_tokens;
      }
      // Total input/output are mandatory. Missing breakdowns stay null rather than manufactured zero.
      usage = {
        input,
        output: Number(u.output_tokens),
        reasoning,
        total: Number(u.total_tokens),
        receipt: sha256(raw),
      };
    } else throw new Error("stock-event-unsupported");
  }
  if (!terminal || !usage || !responseId)
    throw new Error("stock-terminal-missing");
  return {
    bytes: raw,
    state: terminal,
    usage,
    response: { responseId, items, cachedInput, reasoning },
  };
}
