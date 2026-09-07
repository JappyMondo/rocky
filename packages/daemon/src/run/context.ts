import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  BackgroundExecResult,
  ExecResult,
  WorkflowContext,
} from '@rocky/sdk';

import type { RunHeader } from './header.js';
import type { BootContext } from './replay.js';

export type ExternalContext = Pick<
  WorkflowContext,
  'agent' | 'checkpoint' | 'post' | 'scm' | 'linear'
>;

export class ConcurrentContextCallError extends Error {
  constructor() {
    super('concurrent ctx calls are only supported inside ctx.parallel');
    this.name = 'ConcurrentContextCallError';
  }
}

export interface ContextServices {
  exec(
    command: string,
    background: boolean,
  ): Promise<ExecResult | BackgroundExecResult>;
  changedFiles(): Promise<string[]>;
  trackProcessGroup?(pid: number): void | Promise<void>;
  /** Adapters are selected per branch so parallel calls never share a runner. */
  external?: (steps: BootContext) => Partial<ExternalContext>;
}

interface ActiveContext {
  runner: BootContext;
  pending: Promise<void> | undefined;
}

function isBackgroundResult(
  result: ExecResult | BackgroundExecResult,
): result is BackgroundExecResult {
  return 'pid' in result;
}

export function createWorkflowContext(
  runner: BootContext,
  header: Pick<RunHeader, 'issue' | 'branch' | 'ports'>,
  services: ContextServices,
): WorkflowContext {
  const active = new AsyncLocalStorage<ActiveContext>();
  const root: ActiveContext = { runner, pending: undefined };
  const issue = Object.freeze({
    ...header.issue,
    labels: Object.freeze([...header.issue.labels]),
  }) as WorkflowContext['issue'];

  const call = <T>(work: (current: BootContext) => Promise<T>): Promise<T> => {
    const context = active.getStore() ?? root;
    const start = (): Promise<T> => {
      if (context.pending) {
        return context.pending.then(() => {
          throw new ConcurrentContextCallError();
        });
      }
      const operation = work(context.runner);
      const settled = operation.then(
        () => undefined,
        () => undefined,
      );
      context.pending = settled;
      return operation.finally(() => {
        if (context.pending === settled) context.pending = undefined;
      });
    };
    return active.getStore() ? start() : active.run(root, start);
  };

  const external = <K extends keyof ExternalContext>(key: K): ExternalContext[K] => {
    const value = services.external?.(active.getStore()?.runner ?? runner)[key];
    if (!value)
      throw new Error(`ctx.${key} requires an adapter; configure it on the Run runtime`);
    return value;
  };

  function exec(
    command: string,
    opts: { background: true; label?: string },
  ): Promise<BackgroundExecResult>;
  function exec(command: string, opts?: { label?: string }): Promise<ExecResult>;
  function exec(
    command: string,
    opts: { background?: boolean; label?: string } = {},
  ): Promise<ExecResult | BackgroundExecResult> {
    const background = opts.background === true;
    return call(async (current) =>
      current.step(
        background ? 'exec:background' : 'exec',
        {
          ...(opts.label === undefined ? {} : { label: opts.label }),
          ...(background ? { replay: 'restart' as const } : {}),
        },
        async () => {
          const result = await services.exec(command, background);
          if (background && isBackgroundResult(result)) {
            await services.trackProcessGroup?.(result.pid);
          }
          return { status: 'done' as const, result };
        },
      ),
    );
  }

  return Object.freeze({
    issue,
    branch: header.branch,
    ports: [...header.ports],
    stage: (label: string) => (active.getStore()?.runner ?? runner).stage(label),
    step: <T>(label: string, fn: () => T | Promise<T>) =>
      call((current) =>
        current.step('step', { label }, async () => ({
          status: 'done',
          result: await fn(),
        })),
      ),
    exec,
    changedFiles: () =>
      call((current) =>
        current.step('changedFiles', {}, async () => ({
          status: 'done',
          result: await services.changedFiles(),
        })),
      ),
    parallel: <T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, opts = {}) =>
      call((current) =>
        current.parallel('parallel', items, opts, (branch, item, index) =>
          active.run({ runner: branch, pending: undefined }, () => fn(item, index)),
        ),
      ) as Promise<R[]>,
    get agent() { return external('agent'); },
    get checkpoint() { return external('checkpoint'); },
    get post() { return external('post'); },
    get scm() { return external('scm'); },
    get linear() { return external('linear'); },
  });
}
