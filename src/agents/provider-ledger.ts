import { createHash } from "node:crypto";
import { canonical } from "../store/json.js";
import { object, integer, type Action } from "../coordinator/contracts.js";
import type { Lease } from "../store/index.js";

export const gatewayLimits = Object.freeze({
  requestBytes: 2 * 1024 * 1024,
  responseBytes: 1024 * 1024,
  eventBytes: 64 * 1024,
  events: 1024,
  requests: 64,
  connections: 4,
  timeoutMs: 30000,
  images: 8,
});
export function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function exact(value: unknown, fields: string[]) {
  const v = object(value);
  if (Object.keys(v).sort().join() !== [...fields].sort().join())
    throw new Error("gateway-fields");
  return v;
}
function bounded(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new Error("gateway-text");
  return value;
}
export type FrozenRequest = Readonly<{
  body: string;
  digest: string;
  model: "gpt-6-sol" | "gpt-6-astra";
  effort: "medium" | "high";
  images: readonly string[];
}>;
/** Deliberately small supported projection. Unknown provider fields fail closed.
 * Images MUST already be prepared and independently authorized by the trusted host.
 * This is not an image decoder, artifact resolver, or actual-provider compatibility claim.
 */
export function freezeProviderRequest(value: unknown): FrozenRequest {
  const wire = JSON.stringify(value);
  if (!wire || Buffer.byteLength(wire) > gatewayLimits.requestBytes)
    throw new Error("gateway-body-limit");
  const v = exact(JSON.parse(wire), [
    "model",
    "reasoning",
    "instructions",
    "tools",
    "input",
    "stream",
    "store",
  ]);
  if (
    !(
      (v.model === "gpt-6-sol" &&
        exact(v.reasoning, ["effort"]).effort === "medium") ||
      (v.model === "gpt-6-astra" &&
        exact(v.reasoning, ["effort"]).effort === "high")
    )
  )
    throw new Error("gateway-model-effort");
  if (v.stream !== true || v.store !== false) throw new Error("gateway-mode");
  bounded(v.instructions, 128 * 1024);
  if (!Array.isArray(v.tools) || v.tools.length > 32)
    throw new Error("gateway-tools");
  const names = new Set<string>();
  for (const item of v.tools) {
    const tool = exact(item, [
      "type",
      "name",
      "description",
      "parameters",
      "strict",
    ]);
    if (tool.type !== "function" || tool.strict !== true)
      throw new Error("gateway-server-tool");
    const name = bounded(tool.name, 64);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || names.has(name))
      throw new Error("gateway-tool-name");
    names.add(name);
    bounded(tool.description, 8192);
    // The schema is data only. No remote references or executable provider tool variants.
    const schema = object(tool.parameters);
    if (schema.type !== "object") throw new Error("gateway-tool-schema");
    const visit = (x: unknown, depth = 0): void => {
      if (depth > 20) throw new Error("gateway-schema-depth");
      if (x && typeof x === "object")
        for (const [k, child] of Object.entries(x)) {
          if (["$ref", "$dynamicRef", "$id"].includes(k))
            throw new Error("gateway-schema-reference");
          visit(child, depth + 1);
        }
    };
    visit(schema);
  }
  if (!Array.isArray(v.input) || v.input.length < 1 || v.input.length > 256)
    throw new Error("gateway-input");
  const images: string[] = [];
  for (const item of v.input) {
    const msg = exact(item, ["role", "content"]);
    if (
      !["user", "developer", "assistant"].includes(String(msg.role)) ||
      !Array.isArray(msg.content) ||
      msg.content.length > 64
    )
      throw new Error("gateway-message");
    for (const part of msg.content) {
      const p = object(part);
      if (p.type === "input_text") {
        exact(p, ["type", "text"]);
        bounded(p.text, gatewayLimits.requestBytes);
      } else if (p.type === "input_image") {
        exact(p, ["type", "image_url", "detail"]);
        const url = bounded(p.image_url, gatewayLimits.requestBytes);
        if (
          p.detail !== "high" ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
        )
          throw new Error("gateway-image");
        const encoded = url.slice("data:image/png;base64,".length),
          bytes = Buffer.from(encoded, "base64");
        if (
          bytes.toString("base64") !== encoded ||
          bytes.length < 8 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        )
          throw new Error("gateway-image");
        images.push(sha256(bytes));
        if (images.length > gatewayLimits.images)
          throw new Error("gateway-image-limit");
      } else throw new Error("gateway-input-type");
    }
  }
  const body = canonical(v);
  return Object.freeze({
    body,
    digest: sha256(body),
    model: v.model as FrozenRequest["model"],
    effort: (v.reasoning as { effort: FrozenRequest["effort"] }).effort,
    images: Object.freeze(images),
  });
}
export type ProviderRecord = {
  schema: 1;
  id: string;
  action: Action;
  lease: Lease;
  request: FrozenRequest;
  outputCap: number;
  state:
    | "counting"
    | "reserved"
    | "sending"
    | "completed"
    | "incomplete"
    | "rejected"
    | "unknown";
  inputTokens: number | null;
  chargedTokens: number;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    total: number;
    receipt: string;
  } | null;
  reason: string | null;
};
export function validateProviderCount(
  value: unknown,
  request: FrozenRequest,
): number {
  const c = exact(value, ["schema", "digest", "inputTokens"]);
  if (c.schema !== 1 || c.digest !== request.digest)
    throw new Error("gateway-count-mismatch");
  integer(c.inputTokens);
  return c.inputTokens;
}
