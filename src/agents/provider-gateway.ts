import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { canonical } from "../store/json.js";
import { Store, type Lease } from "../store/index.js";
import type { Action } from "../coordinator/contracts.js";
import {
  exact,
  freezeProviderRequest,
  gatewayLimits,
  sha256,
  validateProviderCount,
  type FrozenRequest,
  type ProviderRecord,
} from "./provider-ledger.js";

/** Trusted injection only: no default/live provider exists. count covers ALL input including cached input.
 * send MUST synchronously initiate exactly one POST with these immutable bytes and a provider-enforced
 * output cap covering ALL output including reasoning. No preflight, redirects, retries, alternate routes,
 * remote state, or hidden generation. The future concrete adapter needs separate qualification.
 * Secrets belong only in that adapter's memory, never request bodies, callbacks, receipts or logs.
 */
export interface TrustedProvider {
  count(request: FrozenRequest, signal: AbortSignal): Promise<unknown>;
  send(
    body: string,
    signal: AbortSignal,
  ): Promise<{
    status: number;
    contentType: string;
    body: AsyncIterable<Uint8Array>;
  }>;
}
export type GatewayApproval = {
  id: string;
  body: unknown;
  outputCap: number;
  /** Trusted synchronous check against current image manifest/revision/revocation and profile authority.
   * Must validate the exact prepared image bytes represented here, not reopen a model-selected path.
   * Empty images do not waive action/profile authority. Throw to deny; return undefined only.
   */
  assertCurrent: (request: FrozenRequest) => void;
};
type Approval = Readonly<{
  id: string;
  request: FrozenRequest;
  outputCap: number;
  assertCurrent: GatewayApproval["assertCurrent"];
}>;

export class ProviderGateway {
  readonly capability = null;
  #lease: Lease;
  #action: Action;
  #provider: TrustedProvider;
  #approvals = new Map<string, Approval>();
  #token = randomBytes(32).toString("hex");
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #requests = 0;
  #observations = 0;
  #host = "";
  #revoked = false;
  #active = new Set<AbortController>();
  #jobs = new Set<Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  constructor(
    readonly store: Store,
    lease: Lease,
    action: Action,
    provider: TrustedProvider,
  ) {
    this.#lease = JSON.parse(canonical(lease));
    this.#action = JSON.parse(canonical(action));
    this.#provider = provider;
    store.assertProviderAction(this.#lease, this.#action);
  }
  /** Host-only approval, never an HTTP route. New retries require a new explicitly approved identity. */
  approve(value: GatewayApproval) {
    this.#assert();
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) ||
      this.#approvals.has(value.id) ||
      this.#approvals.size >= gatewayLimits.requests ||
      this.store.providerRecord(this.#action.key, value.id)
    )
      throw new Error("gateway-approval-id");
    if (
      !Number.isSafeInteger(value.outputCap) ||
      value.outputCap < 1 ||
      value.outputCap > this.#action.tokens
    )
      throw new Error("gateway-output-cap");
    const request = freezeProviderRequest(value.body);
    const approval = Object.freeze({
      id: value.id,
      request,
      outputCap: value.outputCap,
      assertCurrent: value.assertCurrent,
    });
    this.#authority(approval);
    this.#approvals.set(value.id, approval);
    return request;
  }
  #assert() {
    if (this.#revoked) throw new Error("gateway-revoked");
    this.store.assertProviderAction(this.#lease, this.#action);
  }
  #authority(approval: Approval) {
    this.#assert();
    if (approval.assertCurrent(approval.request) !== undefined)
      throw new Error("gateway-async-authority");
  }
  /** Exactly one private IPv4 loopback listener, ephemeral port, no proxy/redirect/WebSocket routes. */
  async listen(): Promise<{ url: string; bearer: string }> {
    this.#assert();
    if (this.#server) throw new Error("gateway-already-listening");
    const server = createServer(
      {
        maxHeaderSize: 4096,
        requestTimeout: 5000,
        headersTimeout: 5000,
        keepAliveTimeout: 1,
      },
      (req, res) => {
        const job = this.#handle(req, res);
        this.#jobs.add(job);
        void job.then(
          () => this.#jobs.delete(job),
          () => {
            this.#jobs.delete(job);
            this.revoke();
            res.destroy();
          },
        );
      },
    );
    this.#server = server;
    server.maxConnections = gatewayLimits.connections;
    server.maxRequestsPerSocket = 1;
    server.on("connection", (socket) => {
      this.#requests++;
      this.#sockets.add(socket);
      if (this.#requests > gatewayLimits.requests) {
        this.revoke();
        server.close();
        socket.destroy();
      }
      socket.setTimeout(5000, () => {
        this.#observe({}, Buffer.alloc(0), "connection-timeout");
        socket.destroy();
      });
      socket.on("close", () => this.#sockets.delete(socket));
    });
    server.on("upgrade", (req, socket) => {
      this.#observe(req, Buffer.alloc(0), "unsupported-upgrade");
      socket.destroy();
    });
    server.on("connect", (req, socket) => {
      this.#observe(req, Buffer.alloc(0), "unsupported-connect");
      socket.destroy();
    });
    server.on("checkContinue", (req, res) => {
      this.#observe(req, Buffer.alloc(0), "unsupported-expect");
      res.writeHead(400, { connection: "close" });
      res.end();
    });
    server.on("clientError", (error, socket) => {
      this.#observe(
        {},
        Buffer.from(
          (error as Error & { rawPacket?: Buffer }).rawPacket ?? [],
        ).subarray(0, 4096),
        "malformed-http",
      );
      socket.destroy();
    });
    server.on("dropRequest", (req, socket) => {
      this.#observe(req, Buffer.alloc(0), "connection-reuse");
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      this.#assert();
    } catch (error) {
      await this.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("gateway-bind");
    this.#host = `127.0.0.1:${address.port}`;
    this.#timer = setTimeout(
      () => {
        void this.close();
      },
      Math.max(
        1,
        Math.min(
          gatewayLimits.timeoutMs,
          this.#action.deadline - this.store.clock(),
        ),
      ),
    );
    return {
      url: `http://127.0.0.1:${address.port}/v1/responses`,
      bearer: this.#token,
    };
  }
  revoke() {
    this.store.revokeProviderAction(this.#action);
    this.#revoked = true;
    for (const controller of this.#active) controller.abort();
  }
  async close() {
    this.revoke();
    clearTimeout(this.#timer);
    const server = this.#server;
    if (server) {
      server.close();
      for (const socket of this.#sockets) socket.destroy();
    }
    await Promise.allSettled([...this.#jobs]);
  }
  #observe(
    req: Pick<IncomingMessage, "method" | "url">,
    body: Buffer,
    outcome: string,
  ) {
    this.#observations++;
    if (this.#observations > gatewayLimits.requests) {
      if (this.#observations === gatewayLimits.requests + 1) {
        this.revoke();
        this.#server?.close();
        for (const socket of this.#sockets) socket.destroy();
        this.store.observeProvider(this.#action.runId, {
          method: "other",
          route: "other",
          bytes: 0,
          digest: sha256(""),
          outcome: "ingress-limit",
        });
      }
      return;
    }
    this.store.observeProvider(this.#action.runId, {
      method: req.method === "POST" ? "post" : "other",
      route: req.url === "/v1/responses" ? "responses" : "other",
      bytes: body.length,
      digest: sha256(body),
      outcome,
    });
  }
  async #handle(req: IncomingMessage, res: ServerResponse) {
    let body = Buffer.alloc(0),
      observation = "rejected",
      controller: AbortController | undefined;
    let record: ProviderRecord | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const reply = (status: number, message: string) => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, {
          "content-type": "text/plain",
          connection: "close",
        });
        res.end(message);
      }
    };
    try {
      this.#assert();
      const headers = req.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .map((v) => v.toLowerCase());
      if (
        new Set(headers).size !== headers.length ||
        headers.some(
          (name) =>
            ![
              "host",
              "authorization",
              "x-rocky-request-id",
              "content-type",
              "content-length",
              "connection",
            ].includes(name),
        ) ||
        req.headers.host !== this.#host ||
        req.method !== "POST" ||
        req.url !== "/v1/responses" ||
        req.httpVersion !== "1.1" ||
        req.headers["transfer-encoding"] ||
        req.headers["content-encoding"] ||
        req.headers.expect ||
        req.headers.upgrade ||
        req.headers["content-type"] !== "application/json"
      )
        throw new Error("route");
      const length = req.headers["content-length"];
      if (
        typeof length !== "string" ||
        !/^[1-9][0-9]{0,6}$/.test(length) ||
        Number(length) > gatewayLimits.requestBytes
      )
        throw new Error("length");
      const token = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${this.#token}`);
      if (token.length !== expected.length || !timingSafeEqual(token, expected))
        throw new Error("auth");
      const id = req.headers["x-rocky-request-id"];
      const approval =
        typeof id === "string" ? this.#approvals.get(id) : undefined;
      if (!approval) throw new Error("approval");
      for await (const chunk of req) {
        if (
          bytes + chunk.length > Number(length) ||
          bytes + chunk.length > gatewayLimits.requestBytes
        )
          throw new Error("length");
        chunks.push(Buffer.from(chunk));
        bytes += chunk.length;
      }
      body = Buffer.concat(chunks, bytes);
      if (
        !req.complete ||
        bytes !== Number(length) ||
        body.toString("utf8") !== approval.request.body
      )
        throw new Error("body");
      this.#authority(approval);
      record = this.store.prepareProvider(
        this.#lease,
        this.#action,
        approval.id,
        JSON.parse(approval.request.body),
        approval.outputCap,
      );
      controller = new AbortController();
      this.#active.add(controller);
      const signal = controller.signal;
      // Disconnect revokes observation and further dispatch; an upstream send remains fully charged.
      res.once("close", () => {
        if (!res.writableEnded) controller?.abort();
      });
      const timer = setTimeout(
        () => controller?.abort(),
        Math.max(
          1,
          Math.min(
            gatewayLimits.timeoutMs,
            this.#action.deadline - this.store.clock(),
          ),
        ),
      );
      try {
        const count = await abortable(
          this.#provider.count(approval.request, signal),
          signal,
        );
        const input = validateProviderCount(count, approval.request);
        this.#authority(approval);
        if (signal.aborted) throw new Error("aborted");
        record = this.store.reserveProvider(
          this.#lease,
          this.#action,
          approval.id,
          input,
        );
        const output = canonical({
          ...JSON.parse(approval.request.body),
          max_output_tokens: approval.outputCap,
        });
        const pending = this.store.dispatchProvider(
          this.#lease,
          this.#action,
          approval.id,
          () => {
            this.#authority(approval);
            if (signal.aborted) throw new Error("aborted");
          },
          () => this.#provider.send(output, signal),
        );
        const response = await abortable(pending, signal);
        if (
          response.status !== 200 ||
          response.contentType !== "text/event-stream"
        )
          throw new Error("upstream-status");
        const parsed = await abortable(
          readResponse(
            response.body,
            approval.request,
            input,
            approval.outputCap,
            signal,
          ),
          signal,
        );
        record = this.store.finishProvider(this.#action.key, approval.id, {
          state: parsed.state,
          usage: parsed.usage,
          reason: null,
        });
        observation = parsed.state;
        if (!res.destroyed) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "close",
          });
          res.end(parsed.bytes);
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
        this.#active.delete(controller);
      }
    } catch {
      // Never expose provider error bodies, thrown messages, headers or secrets.
      if (record) {
        const current = this.store.providerRecord(this.#action.key, record.id)!;
        if (["counting", "reserved", "sending"].includes(current.state)) {
          const state = current.state === "sending" ? "unknown" : "rejected";
          this.store.finishProvider(this.#action.key, record.id, {
            state,
            usage: null,
            reason:
              state === "unknown"
                ? "generation-unresolved"
                : "admission-failed",
          });
          observation = state;
        }
      }
      reply(409, "gateway-request-rejected");
    } finally {
      if (!body.length && chunks.length) body = Buffer.concat(chunks, bytes);
      this.#observe(req, body, observation);
      if (!req.complete) req.destroy();
    }
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("gateway-aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
/** Minimal SSE response contract, intentionally not a complete Responses protocol adapter. */
async function readResponse(
  stream: AsyncIterable<Uint8Array>,
  request: FrozenRequest,
  input: number,
  cap: number,
  signal: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("aborted");
    size += chunk.byteLength;
    if (size > gatewayLimits.responseBytes)
      throw new Error("gateway-response-limit");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n\n")) throw new Error("gateway-stream-incomplete");
  const events = text.slice(0, -2).split("\n\n");
  if (events.length > gatewayLimits.events)
    throw new Error("gateway-event-limit");
  let state: "completed" | "incomplete" | undefined,
    usage: ProviderRecord["usage"] = null;
  for (const event of events) {
    if (state || Buffer.byteLength(event) > gatewayLimits.eventBytes)
      throw new Error("gateway-stream-order");
    const match =
      /^event: (response\.output_text\.delta|response\.completed|response\.incomplete)\ndata: ([^\n]+)$/.exec(
        event,
      );
    if (!match) throw new Error("gateway-stream-shape");
    const value = JSON.parse(match[2]!);
    if (match[1] === "response.output_text.delta") {
      const delta = exact(value, ["type", "delta"]);
      if (delta.type !== match[1] || typeof delta.delta !== "string")
        throw new Error("gateway-delta");
    } else {
      const final = exact(value, ["type", "response"]),
        r = exact(final.response, ["model", "status", "usage"]);
      state = match[1] === "response.completed" ? "completed" : "incomplete";
      if (
        final.type !== match[1] ||
        r.model !== request.model ||
        r.status !== state
      )
        throw new Error("gateway-final");
      const u = exact(r.usage, [
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "total_tokens",
      ]);
      for (const n of Object.values(u))
        if (!Number.isSafeInteger(n) || Number(n) < 0)
          throw new Error("gateway-usage");
      if (
        u.input_tokens !== input ||
        Number(u.output_tokens) > cap ||
        Number(u.reasoning_tokens) > Number(u.output_tokens) ||
        u.total_tokens !== Number(u.input_tokens) + Number(u.output_tokens)
      )
        throw new Error("gateway-usage");
      usage = {
        input,
        output: Number(u.output_tokens),
        reasoning: Number(u.reasoning_tokens),
        total: Number(u.total_tokens),
        receipt: sha256(bytes),
      };
    }
  }
  if (!state || !usage) throw new Error("gateway-stream-incomplete");
  return { bytes, state, usage };
}
