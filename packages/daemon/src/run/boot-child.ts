import { randomUUID } from 'node:crypto';
import { rockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import { recordError } from './journal.js';
import type { RunHeader } from './header.js';
import { createProductionRuntime } from './production.js';
import type { WorkflowRuntime } from './lifecycle.js';
import { createAgentSteerBridge } from './steer-bridge.js';
import type { BootRequest } from './worker.js';

let runtime: WorkflowRuntime | undefined;
let config: InstanceConfig;
let controller: AbortController | undefined;
const requests = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();

function send(message: unknown) {
  // Node's IPC send reads its receiver. Calling a captured function loses
  // that receiver and crashes the child before its first workspace request.
  if (process.connected && process.send) process.send(message);
}

function request(request: BootRequest): Promise<unknown> {
  if (!process.connected)
    return Promise.reject(new Error('Boot parent is unavailable'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    requests.set(id, { resolve, reject });
    send({ type: 'request', id, request });
  });
}

async function stop() {
  controller?.abort();
  for (const request of requests.values())
    request.reject(new Error('Boot stopped'));
  requests.clear();
  await runtime?.close();
}

process.on('disconnect', () => {
  void stop().finally(() => process.exit(0));
});
process.on(
  'message',
  (
    message:
      | {
          type: 'boot';
          run: RunHeader;
          kind: 'run' | 'poll';
          root: string;
          config: InstanceConfig;
        }
      | { type: 'abort' }
      | {
          type: 'reply';
          id: string;
          result?: unknown;
          error?: { name: string; message: string };
        },
  ) => {
    if (message.type === 'reply') {
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.error)
        pending?.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else pending?.resolve(message.result);
      return;
    }
    if (message.type === 'abort') {
      void stop();
      return;
    }
    if (controller) {
      send({
        type: 'error',
        error: recordError(new Error('Concurrent Boots are not supported')),
      });
      return;
    }
    config = message.config;
    controller = new AbortController();
    runtime ??= createProductionRuntime({
      paths: rockyPaths(message.root),
      config: () => config,
      request,
      steer: createAgentSteerBridge(request),
      onEvent: (stepKey, event, sessionId) =>
        send({
          type: 'event',
          runId: message.run.runId,
          stepKey,
          event: { event, sessionId },
        }),
    });
    void runtime
      .boot(message.run, message.kind, controller.signal)
      .then(
        (result) => send({ type: 'result', result }),
        (error) => send({ type: 'error', error: recordError(error) }),
      )
      .finally(() => {
        controller = undefined;
      });
  },
);
