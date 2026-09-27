import { createHash } from "node:crypto";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === "string" || typeof v === "boolean")
      return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || !v || seen.has(v))
      throw new Error("plain-json-required");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) result = "[" + Array.from(v, encode).join(",") + "]";
    else {
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw new Error("plain-json-required");
      result =
        "{" +
        Object.keys(v)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ":" +
              encode((v as Record<string, unknown>)[k]),
          )
          .join(",") +
        "}";
    }
    seen.delete(v);
    return result;
  }
  return encode(value);
}
export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function identity(value: unknown): string {
  return digest(canonical(value));
}
