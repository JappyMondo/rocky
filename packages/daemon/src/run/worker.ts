import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RockyPaths } from '../config/paths.js';
import type { InstanceConfig } from '../config/schema.js';
import type { RunHeader } from './header.js';
import type { AppendOptions, JournalEntry } from './journal.js';
import type { BootResult } from './replay.js';

// Keep the watchdog outside the Workflow's event loop and process group. IPC
// disconnect still reaches it when the daemon dies and the Workflow is stuck.
const supervisor = `
const { spawn } = require('node:child_process');
let child, stopping = false, killed = false, closed = false;
function send(target, message) {
  if (target.connected) target.send(message, () => {});
}
function signal(name) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function finish() { if (killed && (!child || closed)) process.exit(0); }
function stop() {
  if (stopping) return;
  stopping = true;
  if (child) send(child, { type: 'abort' });
  setTimeout(() => {
    signal('SIGTERM');
    setTimeout(() => { signal('SIGKILL'); killed = true; finish(); }, 150);
  }, 150);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', message => {
  if (message.type === 'stop') return stop();
  if (stopping) return;
  if (child) return send(child, message);
  child = spawn(process.execPath, [process.argv[1]], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.on('spawn', () => send(child, message));
  child.on('message', message => send(process, message));
  child.on('error', error => {
    send(process, { type: 'error', error: { name: error.name, message: error.message } });
    stop();
  });
  child.on('disconnect', stop);
  child.on('close', (code, signal) => {
    closed = true;
    send(process, { type: 'error', error: { name: 'Error',
      message: 'Boot child exited unexpectedly (' + (signal ?? code) + ')' } });
    stop();
    finish();
  });
});
`;

export type BootRequest =
  | { kind: 'append'; entry: JournalEntry; options?: AppendOptions }
  | { kind: 'workspace' }
  | { kind: 'control-get'; key: string }
  | { kind: 'control-put'; key: string; value: unknown }
  | { kind: 'agent-steer-open'; stepKey: string; label: string; group?: string }
  | { kind: 'agent-steer-take'; stepKey: string }
  | { kind: 'agent-steer-delivered'; stepKey: string; ids: string[] }
  | { kind: 'agent-steer-close'; stepKey: string };

export interface RunWorkersOptions {
  paths: RockyPaths;
  config: () => InstanceConfig;
  /** Test fixture only; production runs the compiled boot-child.js module. */
  childModule?: URL;
  onEvent?: (runId: string, stepKey: string, event: unknown) => void;
  onError?: (error: unknown) => void;
  onRequest?: (
    runId: string,
    request: BootRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

interface Worker {
  process: ChildProcess;
  closed: Promise<void>;
  stopping: boolean;
  requests: Set<Promise<void>>;
  conversations: Set<string>;
  pending?: {
    signal: AbortSignal;
    accepting: boolean;
    resolve: (result: BootResult) => void;
    reject: (error: Error) => void;
  };
}

type Message =
  | { type: 'request'; id: string; request: BootRequest }
  | { type: 'result'; result: BootResult }
  | { type: 'error'; error: { name: string; message: string; stack?: string } }
  | { type: 'event'; runId: string; stepKey: string; event: unknown };

export class RunWorkers {
  private readonly options: RunWorkersOptions;
  private readonly workers = new Map<string, Worker>();
  private closed = false;

  constructor(options: RunWorkersOptions) {
    this.options = options;
  }

  boot = async (
    run: RunHeader,
    kind: 'run' | 'poll',
    signal: AbortSignal,
  ): Promise<BootResult> => {
    if (this.closed) throw new Error('Run workers are closed');
    if (signal.aborted) throw new Error(`Boot cancelled for ${run.runId}`);
    let worker = this.workers.get(run.runId);
    if (worker?.pending || worker?.stopping)
      throw new Error(`A Boot is already active or stopping for ${run.runId}`);
    const config = this.options.config();
    worker ??= this.start(run.runId);
    const owned = worker;
    const result = new Promise<BootResult>((resolve, reject) => {
      owned.pending = { resolve, reject, signal, accepting: true };
      owned.process.send(
        { type: 'boot', run, kind, root: this.options.paths.root, config },
        (error) => {
          if (error) reject(error);
        },
      );
    });
    const abort = () => {
      void this.stop(owned);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const outcome = await result;
      await Promise.all(owned.requests);
      if (owned.stopping)
        throw new Error(`Boot worker stopped for ${run.runId}`);
      if (outcome.status !== 'parked' && outcome.status !== 'ready')
        await this.stop(owned);
      if (signal.aborted) {
        await this.stop(owned);
        throw new Error(`Boot cancelled for ${run.runId}`);
      }
      return outcome;
    } catch (error) {
      await this.stop(owned);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      owned.pending = undefined;
    }
  };

  kill = async (run: RunHeader): Promise<void> => {
    const worker = this.workers.get(run.runId);
    if (worker) await this.stop(worker);
  };

  close = async (): Promise<void> => {
    this.closed = true;
    await Promise.all(
      [...this.workers.values()].map((worker) => this.stop(worker)),
    );
  };

  private start(runId: string): Worker {
    const child = spawn(
      process.execPath,
      [
        '-e',
        supervisor,
        fileURLToPath(
          this.options.childModule ??
            new URL('./boot-child.js', import.meta.url),
        ),
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const worker: Worker = {
      process: child,
      stopping: false,
      requests: new Set(),
      conversations: new Set(),
      closed: new Promise<void>((resolve) => {
        child.once('close', () => {
          worker.stopping = true;
          worker.pending?.reject(new Error(`Boot worker stopped for ${runId}`));
          void Promise.allSettled(worker.requests).then(async () => {
            await this.closeConversations(worker, runId);
            this.workers.delete(runId);
            resolve();
          });
        });
      }),
    };
    child.on('error', (error) => worker.pending?.reject(error));
    child.on('message', (message: Message) => {
      if (message.type === 'request') {
        const request = this.request(worker, runId, message).catch(
          (error: Error) => {
            worker.pending?.reject(error);
          },
        );
        worker.requests.add(request);
        void request.then(() => worker.requests.delete(request));
      } else if (message.type === 'result' && worker.pending) {
        worker.pending.accepting = false;
        worker.pending.resolve(message.result);
      } else if (message.type === 'error') {
        worker.pending?.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      } else if (message.type === 'event' && message.runId === runId) {
        try {
          this.options.onEvent?.(runId, message.stepKey, message.event);
        } catch {
          /* Display output cannot strand a Boot. */
        }
      }
    });
    this.workers.set(runId, worker);
    return worker;
  }

  private async stop(worker: Worker): Promise<void> {
    if (!worker.stopping) {
      worker.stopping = true;
      if (worker.process.connected)
        worker.process.send({ type: 'stop' }, () => {
          // A closed IPC channel already triggers watchdog cleanup.
        });
    }
    await worker.closed;
  }

  private async request(
    worker: Worker,
    runId: string,
    message: Extract<Message, { type: 'request' }>,
  ): Promise<void> {
    const send = (reply: object) => {
      if (worker.process.connected)
        worker.process.send(
          { type: 'reply', id: message.id, ...reply },
          (error) => {
            if (error) worker.pending?.reject(error);
          },
        );
    };
    try {
      if (!worker.pending?.accepting || worker.stopping)
        throw new Error(`No active Boot accepts requests for ${runId}`);
      if (!this.options.onRequest)
        throw new Error(
          `Configure RunWorkers.onRequest to handle ${message.request.kind} requests`,
        );
      const result = await this.options.onRequest(
        runId,
        message.request,
        worker.pending.signal,
      );
      if (message.request.kind === 'agent-steer-open') {
        worker.conversations.add(message.request.stepKey);
      } else if (message.request.kind === 'agent-steer-close') {
        worker.conversations.delete(message.request.stepKey);
      }
      send({ result });
    } catch (error) {
      send({
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async closeConversations(
    worker: Worker,
    runId: string,
  ): Promise<void> {
    const conversations = [...worker.conversations];
    worker.conversations.clear();
    const onRequest = this.options.onRequest;
    if (!onRequest) return;
    const outcomes = await Promise.allSettled(
      conversations.map((stepKey) =>
        onRequest(
          runId,
          { kind: 'agent-steer-close', stepKey },
          new AbortController().signal,
        ),
      ),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'rejected') continue;
      try {
        this.options.onError?.(
          new Error(
            `Could not close Agent conversation ${conversations[index]} for ${runId}`,
            { cause: outcome.reason },
          ),
        );
      } catch {
        // Reporting cannot strand worker teardown.
      }
    }
  }
}
