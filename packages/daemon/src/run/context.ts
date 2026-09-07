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

export interface ContextServices {
  exec(
    command: string,
    background: boolean,
  ): Promise<ExecResult | BackgroundExecResult>;
  changedFiles(): Promise<string[]>;
  /** Each adapter journals through the supplied branch-local Steps. */
  external?: (steps: BootContext) => Partial<ExternalContext>;
}

export function createWorkflowContext(
  runner: BootContext,
  header: Pick<RunHeader, 'issue' | 'branch' | 'ports'>,
  services: ContextServices,
): WorkflowContext {
  const branch = new AsyncLocalStorage<BootContext>();
  const current = () => branch.getStore() ?? runner;
  const issue = structuredClone(header.issue);
  Object.freeze(issue.labels);
  Object.freeze(issue);
  const external = <K extends keyof ExternalContext>(
    key: K,
  ): ExternalContext[K] => {
    const member = services.external?.(current())[key];
    if (!member)
      throw new Error(
        `ctx.${key} requires an adapter; configure it on the Run runtime`,
      );
    return member;
  };
  function exec(
    command: string,
    opts: { background: true; label?: string },
  ): Promise<BackgroundExecResult>;
  function exec(
    command: string,
    opts?: { label?: string },
  ): Promise<ExecResult>;
  function exec(
    command: string,
    opts: { background?: boolean; label?: string } = {},
  ) {
    return current().step(
      opts.background ? 'exec:background' : 'exec',
      {
        label: opts.label,
        ...(opts.background ? { replay: 'restart' as const } : {}),
      },
      async () => ({
        status: 'done',
        result: await services.exec(command, opts.background ?? false),
      }),
    );
  }
  return Object.freeze({
    issue,
    branch: header.branch,
    ports: [...header.ports],
    stage: (label: string) => current().stage(label),
    step: <T>(label: string, fn: () => T | Promise<T>) =>
      current().step('step', { label }, async () => ({
        status: 'done',
        result: await fn(),
      })),
    exec,
    changedFiles: () =>
      current().step('changedFiles', {}, async () => ({
        status: 'done',
        result: await services.changedFiles(),
      })),
    async parallel<T, R>(
      items: readonly T[],
      fn: (item: T, index: number) => Promise<R>,
      opts = {},
    ): Promise<R[]> {
      return (await current().parallel(
        'parallel',
        items,
        opts,
        (steps, item, index) => branch.run(steps, () => fn(item, index)),
      )) as R[];
    },
    get agent() {
      return external('agent');
    },
    get checkpoint() {
      return external('checkpoint');
    },
    get post() {
      return external('post');
    },
    get scm() {
      return external('scm');
    },
    get linear() {
      return external('linear');
    },
  });
}
