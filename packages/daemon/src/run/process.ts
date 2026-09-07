import { spawn } from 'node:child_process';
import type { BackgroundExecResult, ExecResult } from '@rocky/sdk';

export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

// A tiny IPC supervisor owns the detached shell group. Even SIGKILL of the
// daemon closes IPC, so grandchildren cannot outlive a lost runtime. Inline
// JavaScript runs identically from source and from the packaged daemon.
const supervisor = `
const { spawn } = require('node:child_process');
let child, stopping = false;
function signal(name) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
function stop() {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, 100);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', message => {
  if (message === 'stop') return stop();
  if (child || stopping) return;
  child = spawn(message.command, { shell: true, detached: true, stdio: ['ignore', 1, 2] });
  child.on('error', error => { if (process.connected) process.send({ error: error.message }); stop(); });
  child.on('spawn', () => { if (process.connected) process.send({ pid: child.pid }); });
  child.on('exit', (code, signal) => {
    if (process.connected) process.send({ exitCode: code ?? 128, signal });
    stop();
  });
});
`;

export interface OwnedCommand {
  result: Promise<ExecResult | BackgroundExecResult>;
  closed: Promise<void>;
  stop(): Promise<void>;
}

export function startCommand(
  command: string,
  options: {
    cwd: string;
    background: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): OwnedCommand {
  const worker = spawn(process.execPath, ['-e', supervisor], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let resolve!: (result: ExecResult | BackgroundExecResult) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ExecResult | BackgroundExecResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => undefined);
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let exitCode: number | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((done) => {
    worker.once('close', () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (exitCode !== undefined) resolve({ exitCode, stdout, stderr });
      else reject(new Error('Command stopped before completion'));
      done();
    });
  });
  const stop = async () => {
    if (!stopped && worker.connected) {
      stopped = true;
      worker.send('stop');
    }
    await closed;
  };
  const abort = () => {
    reject(new Error('Command cancelled'));
    void stop();
  };
  const output = (chunk: string, error: boolean) => {
    if (options.background) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) {
      reject(new Error('Command output exceeded 16 MiB'));
      void stop();
      return;
    }
    if (error) stderr += chunk;
    else stdout += chunk;
  };
  worker.stdout
    ?.setEncoding('utf8')
    .on('data', (chunk) => output(chunk, false));
  worker.stderr?.setEncoding('utf8').on('data', (chunk) => output(chunk, true));
  worker.once('error', reject);
  worker.on(
    'message',
    (message: { pid?: number; exitCode?: number; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      if (message.exitCode !== undefined) exitCode = message.exitCode;
      if (message.pid && options.background) resolve({ pid: message.pid });
    },
  );
  worker.once('spawn', () => {
    if (options.signal?.aborted) {
      abort();
      return;
    }
    worker.send({ command });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (!options.background)
      timer = setTimeout(() => {
        reject(
          new Error(
            `Command timed out after ${options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS} ms`,
          ),
        );
        void stop();
      }, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  });
  return { result, closed, stop };
}
