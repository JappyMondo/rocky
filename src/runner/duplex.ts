import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { Action } from "../coordinator/contracts.js";
import type { Store, Lease, CommandRecord } from "../store/index.js";
import { canonical, type Json } from "../store/json.js";
import { CommandRunner, type CommandSpec } from "./index.js";
import type { BinaryIdentity } from "./process.js";

export interface DuplexLimits {
  frameBytes: number;
  inputBytes: number;
  outputBytes: number;
  inputFrames: number;
  outputFrames: number;
}
export interface DuplexBinding {
  action: Action;
  limits: DuplexLimits;
  request: Json;
  /** Optional pinned-binary identity re-measured by the gate inside the guarded start (C1). */
  binaryIdentity?: BinaryIdentity;
}
export interface DuplexStartExtra {
  binaryIdentity?: BinaryIdentity;
  /** Adapter-computed immutable bundle digest bound into the invocation identity. */
  bundleDigest?: string;
}
export interface DuplexSend {
  key: string;
  wire: string;
  end: boolean;
  state: "queued" | "writing" | "written";
  attempted?: true;
}
export interface DuplexState extends DuplexBinding {
  schema: 1;
  sends: DuplexSend[];
  frames: Json[];
  inputBytes: number;
  outputBytes: number;
  revoked: boolean;
  failure: string | null;
  stdoutEof: boolean;
  stderrEof: boolean;
  // Absent on earlier schema-5 records; absence is never decoder completion.
  childStdoutEof?: boolean;
  childStderrEof?: boolean;
  decoderComplete?: boolean;
}
export function validateDuplexLimits(limits: DuplexLimits) {
  for (const key of [
    "frameBytes",
    "inputBytes",
    "outputBytes",
    "inputFrames",
    "outputFrames",
  ] as const) {
    // The frame bound also caps a single one-shot raw stdin write; direct-harness contracts
    // admit a prompt up to min(config, 10 MB) written once, so frames admit the same bound.
    const max = key.endsWith("Frames")
      ? 4096
      : key === "frameBytes"
        ? 10 * 1024 * 1024
        : 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > max
    )
      throw new Error("invalid-duplex-limit");
  }
  canonical(limits);
}
/** Newline-delimited plain JSON, strict UTF-8; EOF never supplies a protocol final. */
export class JsonLineDecoder {
  #pending = Buffer.alloc(0);
  constructor(
    readonly limit: number,
    readonly frame: (value: Json) => void,
  ) {}
  push(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (this.#pending.length + part.length > this.limit)
        throw new Error("duplex-frame-limit");
      this.#pending = Buffer.concat([this.#pending, part]);
      if (newline >= 0) {
        let value: Json;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            this.#pending.subarray(0, -1),
          );
          value = JSON.parse(text);
          canonical(value);
        } catch {
          throw new Error("duplex-malformed-frame");
        }
        this.#pending = Buffer.alloc(0);
        this.frame(value);
      }
      offset = end;
    }
  }
  end() {
    if (this.#pending.length) throw new Error("duplex-partial-frame");
  }
}
/** Owned transport primitive, not a qualified agent adapter. No application-result interpretation. */
export class DuplexRunner {
  readonly capability = null;
  readonly commands: CommandRunner;
  constructor(readonly store: Store) {
    this.commands = new CommandRunner(store);
  }
  start(
    lease: Lease,
    action: Action,
    spec: CommandSpec,
    limits: DuplexLimits,
    extra: DuplexStartExtra = {},
  ): string {
    validateDuplexLimits(limits);
    if (spec.logBytes > 16 * 1024 * 1024)
      throw new Error("invalid-duplex-log-limit");
    if (
      extra.binaryIdentity !== undefined &&
      typeof extra.bundleDigest !== "string"
    )
      throw new Error("invalid-duplex-start-extra");
    const request = JSON.parse(
      canonical({
        action,
        spec: {
          ...spec,
          cwd: resolve(spec.cwd),
          outputDir: resolve(spec.outputDir),
        },
        limits,
        ...(extra.bundleDigest !== undefined
          ? { bundleDigest: extra.bundleDigest }
          : {}),
        ...(extra.binaryIdentity !== undefined
          ? { binaryIdentity: extra.binaryIdentity }
          : {}),
      }),
    ) as Json;
    const old = this.store.duplexInvocation(action.key);
    if (old) {
      if (
        old.runId !== lease.runId ||
        canonical(old.duplex?.request) !== canonical(request)
      )
        throw new Error("duplex-invocation-conflict");
      // This is observation, not a start retry, even when the supervisor is gone.
      return old.id;
    }
    const binding: DuplexBinding = { action, limits, request };
    if (extra.binaryIdentity !== undefined)
      binding.binaryIdentity = extra.binaryIdentity;
    return this.store.guardedStart(lease, () => {
      this.store.assertDuplexAction(lease, action);
      return this.commands.start(lease, spec, binding);
    });
  }
  send(lease: Lease, id: string, key: string, frame: Json) {
    return this.store.queueDuplex(lease, id, key, frame);
  }
  /** Queue exact raw UTF-8 text (no JSON framing) as one durable once-only stdin write. */
  sendText(lease: Lease, id: string, key: string, text: string) {
    return this.store.queueDuplexText(lease, id, key, text);
  }
  end(lease: Lease, id: string, key: string) {
    return this.store.queueDuplex(lease, id, key, null, true);
  }
  interrupt(lease: Lease, action: Action) {
    this.store.revokeDuplex(lease, action.key);
  }
  observe(id: string): CommandRecord {
    const record = this.store.command(id);
    if (!record?.duplex) throw new Error("duplex-not-found");
    return record;
  }
  async wait(lease: Lease, id: string) {
    const record = await this.commands.wait(lease, id);
    return {
      record,
      quiescent:
        record.state === "finished" &&
        record.duplex?.stdoutEof === true &&
        record.duplex.stderrEof === true,
    };
  }
}
