import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ApprovedCheckpoint,
  Question,
  BackgroundExecResult,
  CheckpointAnswer,
  ExecResult,
  WorkflowContext,
} from '@rocky/sdk';
import type { RunHeader } from './header.js';
import type { BootContext, StepOutcome } from './replay.js';

type RawCheckpointAnswer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

/** A verifier can validate but cannot mint an approval capability. */
export type CheckpointApprovalVerifier = (
  approval: ApprovedCheckpoint,
) => boolean;

export type ExternalContext = Pick<
  WorkflowContext,
  'agent' | 'post' | 'scm' | 'linear' | 'comment'
>;
export type ExternalServices = Partial<ExternalContext> & {
  checkpoint?: (
    opts: {
      title: string;
      body: string;
      kind?: 'question';
      options?: string[];
    },
    stepKey: string,
  ) => Promise<StepOutcome<RawCheckpointAnswer>>;
};

export interface ContextServices {
  exec(
    command: string,
    background: boolean,
  ): Promise<ExecResult | BackgroundExecResult>;
  changedFiles(): Promise<string[]>;
  /** Each adapter is given the branch-local approval verifier. */
  external?: (
    steps: BootContext,
    approvals: CheckpointApprovalVerifier,
  ) => ExternalServices;
}

// Kept module-private so a Workflow can never construct an accepted value.
const approvedCheckpoints = new WeakMap<object, BootContext>();

export function createWorkflowContext(
  runner: BootContext,
  header: Pick<RunHeader, 'issue' | 'branch' | 'ports'>,
  services: ContextServices,
): WorkflowContext {
  const branch = new AsyncLocalStorage<BootContext>();
  const current = () => branch.getStore() ?? runner;
  const approvals: CheckpointApprovalVerifier = (approval) =>
    typeof approval === 'object' &&
    approval !== null &&
    approvedCheckpoints.get(approval) === current();
  const issue = structuredClone(header.issue);
  Object.freeze(issue.labels);
  Object.freeze(issue);
  const external = <K extends keyof ExternalContext>(
    key: K,
  ): ExternalContext[K] => {
    const member = services.external?.(current(), approvals)[key];
    if (!member)
      throw new Error(
        `ctx.${key} requires an adapter; configure it on the Run runtime`,
      );
    return member as ExternalContext[K];
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
      return async (opts: {
        title: string;
        body: string;
      }): Promise<CheckpointAnswer> => {
        const checkpoint = services.external?.(current(), approvals).checkpoint;
        if (!checkpoint)
          throw new Error(
            'ctx.checkpoint requires an adapter; configure it on the Run runtime',
          );
        // Checkpoints are ctx calls, so the daemon—not an arbitrary adapter—
        // owns their one journal Step. This also makes a completed raw answer
        // replay before its Boot-local approval capability is minted.
        const answer = await current().step(
          'checkpoint',
          { label: opts.title },
          (handle) => checkpoint(opts, handle.identity),
        );
        if (answer.decision !== 'approve') return answer;
        const approved = Object.freeze({
          decision: 'approve',
        }) as ApprovedCheckpoint;
        approvedCheckpoints.set(approved, current());
        return approved;
      };
    },
    async question(opts: Question) {
      if (
        !opts.title.trim() ||
        !opts.body.trim() ||
        opts.options?.some((option) => !option.trim())
      )
        throw new Error(
          'A Question requires a title, body, and nonempty options',
        );
      const checkpoint = services.external?.(current(), approvals).checkpoint;
      if (!checkpoint)
        throw new Error('ctx.question requires a checkpoint adapter');
      const answer = await current().step(
        'question',
        { label: opts.title },
        (handle) => checkpoint({ ...opts, kind: 'question' }, handle.identity),
      );
      if (answer.decision === 'reject') return { cancelled: true as const };
      if (answer.decision !== 'steer' || !answer.message.trim())
        throw new Error('A Question requires a written answer');
      return { answer: answer.message };
    },
    get comment() {
      return external('comment');
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
