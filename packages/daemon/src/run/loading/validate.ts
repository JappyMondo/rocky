import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowLoadError, type TriggerSelector } from './loader.js';

export interface SnapshotValidationOptions {
  validationTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function validateSnapshotTriggers(
  snapshotDir: string,
  options: SnapshotValidationOptions = {},
): Promise<TriggerSelector[]> {
  options.signal?.throwIfAborted();
  const timeout = options.validationTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('validationTimeoutMs must be positive and finite');
  const entry = new URL('./validate-child.js', import.meta.url);
  if (!existsSync(entry))
    entry.pathname = entry.pathname.replace(/\.js$/, '.ts');
  const directory = resolve(snapshotDir);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [directory], {
      cwd: directory,
      execArgv: [],
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result: TriggerSelector[] | undefined;
    let failure: string | undefined;
    let stderr = '';
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      failure = `import timed out after ${timeout}ms; remove blocking top-level code`;
      kill();
    }, timeout);
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.once(
      'message',
      (message: { triggers?: TriggerSelector[]; error?: string }) => {
        if (Array.isArray(message?.triggers)) result = message.triggers;
        else
          failure =
            message?.error ?? 'validation child returned no Trigger table';
        kill();
      },
    );
    child.once('error', (error) => {
      failure = error.message;
      kill();
    });
    child.once('exit', kill);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      if (result && !failure) resolve(result);
      else
        reject(
          new WorkflowLoadError(
            'invalid-workflow',
            join(snapshotDir, 'workflow.ts'),
            failure ?? `validation child exited (${code ?? signal}): ${stderr}`,
            'Fix .rocky/workflow.ts and its named imports, remove blocking top-level code, then retry.',
          ),
        );
    });
  });
}
