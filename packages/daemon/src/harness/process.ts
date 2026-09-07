import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { HarnessError, type HarnessInvocation } from './types.js';

export async function assertSessionOwner(
  input: HarnessInvocation & { sessionId: string },
  key: string,
): Promise<void> {
  let last: string | undefined;
  try {
    for (const line of (await readFile(input.transcriptPath, 'utf8')).split(
      '\n',
    )) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (typeof record[key] === 'string') last = record[key];
    }
  } catch {
    /* A missing or torn Transcript cannot authorize an unknown session. */
  }
  if (last !== input.sessionId)
    throw new HarnessError(
      'Session does not belong to this Step Transcript; start a new conversation',
      false,
    );
}

/** Owns only this child's process group, never a shared Harness daemon. */
export async function runProcess(input: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  transcriptPath?: string;
  onLine?: (line: string) => void;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  input.signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid Harness timeout');
  let fd: number | undefined;
  if (input.transcriptPath) {
    mkdirSync(dirname(input.transcriptPath), { recursive: true, mode: 0o700 });
    fd = openSync(
      input.transcriptPath,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failure: unknown;
      let stdout = '';
      let stderr = '';
      let pending = '';
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const decoder = new StringDecoder('utf8');
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32')
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            failure ??= error;
        }
      };
      const stop = (error: unknown) => {
        if (failure !== undefined) return;
        failure = error;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 500);
      };
      const abort = () =>
        stop(
          input.signal?.reason ??
            new DOMException('Harness cancelled', 'AbortError'),
        );
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      const timer = setTimeout(
        () =>
          stop(new DOMException('Harness attempt timed out', 'TimeoutError')),
        timeoutMs,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          if (fd !== undefined) writeSync(fd, chunk);
          const text = decoder.write(chunk);
          stdout += text;
          if (stdout.length > 32 * 1024 * 1024)
            throw new Error('Harness stream exceeds 32 MiB');
          pending += text;
          let end: number;
          while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end).replace(/\r$/, '');
            pending = pending.slice(end + 1);
            if (line) input.onLine?.(line);
          }
        } catch (error) {
          stop(error);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024);
      });
      child.on('error', (error) => {
        failure ??= error;
      });
      child.on('exit', () => kill('SIGKILL'));
      child.on('close', (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        // The leader can exit before descendants. Reap the owned group first.
        if (killTimer) {
          clearTimeout(killTimer);
          kill('SIGKILL');
        }
        try {
          pending += decoder.end();
          if (pending.trim() && failure === undefined) input.onLine?.(pending);
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) reject(failure);
        else resolve({ code, stdout, stderr });
      });
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
