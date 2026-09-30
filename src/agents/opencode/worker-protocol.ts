import type { Action } from "../../coordinator/contracts.js";
import type { Lease } from "../../store/index.js";
import type { OpencodeConfig } from "./config.js";
import { canonical } from "../../store/json.js";
export interface WorkerRequest {
  schema: 1;
  nonce: string;
  db: string;
  lease: Lease;
  action: Action;
  config: OpencodeConfig;
  prompt: string;
  directory: string;
}
export interface WorkerMessage {
  schema: 1;
  nonce: string;
  actionKey: string;
  type: "preflight" | "freeze" | "plan" | "begin" | "result" | "error" | "stop";
  payload: unknown;
}
export function validateWorkerMessage(
  value: unknown,
  request: WorkerRequest,
): WorkerMessage {
  const m = value as WorkerMessage;
  if (
    !m ||
    Object.keys(m).sort().join() !== "actionKey,nonce,payload,schema,type" ||
    m.schema !== 1 ||
    m.nonce !== request.nonce ||
    m.actionKey !== request.action.key ||
    ![
      "preflight",
      "freeze",
      "plan",
      "begin",
      "result",
      "error",
      "stop",
    ].includes(m.type) ||
    Buffer.byteLength(canonical(m)) >
      request.config.limits.maxPromptBytes * 2 + 131072
  )
    throw new Error("opencode-worker-protocol");
  return m;
}
export function workerMessage(
  request: WorkerRequest,
  type: WorkerMessage["type"],
  payload: unknown = null,
): WorkerMessage {
  return validateWorkerMessage(
    {
      schema: 1,
      nonce: request.nonce,
      actionKey: request.action.key,
      type,
      payload,
    },
    request,
  );
}
