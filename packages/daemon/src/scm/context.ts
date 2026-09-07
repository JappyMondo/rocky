import { createHash } from 'node:crypto';
import type {
  ApprovedCheckpoint,
  CiResult,
  MergeResult,
  OpenPrOptions,
  ScmPr as Pr,
  ReviewThread,
  ScmOps,
  ScmRefusal,
  UpdateBranchResult,
} from '@rocky/sdk';
import type { BootContext, StepOutcome } from '../run/replay.js';
import type { CheckpointApprovalVerifier } from '../run/context.js';
import { refuse, ScmError, type ScmRepository } from './http.js';

/** A single platform request/poll, not another scheduler. Errors are safe ScmErrors. */
export interface ScmAdapter {
  repo: ScmRepository;
  signal: AbortSignal | undefined;
  openPr(input: OpenPrOptions): Promise<Pr>;
  markDraft(pr: Pr, draft: boolean, input?: { body?: string }): Promise<Pr>;
  waitForCi(
    pr: Pr,
    input: { logTailLines: number },
  ): Promise<StepOutcome<CiResult>>;
  retryFailedJobs(pr: Pr): Promise<void>;
  updateBranch(pr: Pr): Promise<StepOutcome<UpdateBranchResult>>;
  armAutoMerge(pr: Pr): Promise<StepOutcome<MergeResult>>;
  reviewThreads(pr: Pr): Promise<ReviewThread[]>;
  replyToThread(
    thread: ReviewThread,
    body: string,
    runId: string,
  ): Promise<void>;
}

export interface ScmContextOptions {
  runId: string;
  lead: string;
  members: readonly ScmAdapter[];
  signal: AbortSignal;
  /** Bound by createWorkflowContext to this branch-local Boot. */
  approvals: CheckpointApprovalVerifier;
  /** Idempotent upsert/activity in the existing Linear thread, never a new PR comment. */
  onRefusal(
    notice: { key: string; refusal: ScmRefusal },
    signal: AbortSignal,
  ): Promise<void>;
}

export function createScm(
  steps: BootContext,
  options: ScmContextOptions,
): ScmOps {
  const members = new Map(
    options.members.map((member) => [member.repo.id, member]),
  );
  if (members.size !== options.members.length || !members.has(options.lead))
    throw new Error('SCM requires unique Run members and a valid lead');
  for (const member of members.values())
    if (member.signal !== options.signal)
      throw new Error(
        `SCM member ${member.repo.id} must use the Boot AbortSignal`,
      );
  const call = <T>(
    operation: string,
    repo: string,
    input: unknown,
    effect: (adapter: ScmAdapter) => Promise<StepOutcome<T>>,
  ): Promise<T | ScmRefusal> => {
    const digest = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    return steps.step<T | ScmRefusal>(
      `scm.${operation}:${repo}:${digest}`,
      { label: `${operation}: ${repo}` },
      async () => {
        options.signal.throwIfAborted();
        const adapter = members.get(repo);
        if (!adapter)
          throw new Error(
            `Unknown SCM Run member ${repo}; use a member from the frozen Run`,
          );
        try {
          const result = await effect(adapter);
          options.signal.throwIfAborted();
          return result;
        } catch (error) {
          options.signal.throwIfAborted();
          if (!(error instanceof ScmError)) throw error;
          if (error.refusal.reason === 'rate_limited')
            return { status: 'waiting' };
          if (
            operation === 'armAutoMerge' &&
            [
              'permission_denied',
              'permission_unknown',
              'unsupported',
              'blocked_status',
            ].includes(error.refusal.reason)
          ) {
            const key = createHash('sha256')
              .update(
                JSON.stringify([
                  options.runId,
                  repo,
                  input,
                  error.refusal.reason,
                ]),
              )
              .digest('hex');
            await options.onRefusal(
              { key: `scm-refusal:${key}`, refusal: error.refusal },
              options.signal,
            );
            options.signal.throwIfAborted();
            return { status: 'waiting' };
          }
          return { status: 'done', result: error.refusal };
        }
      },
    );
  };
  return {
    openPr: (input) =>
      call('openPr', input.repo ?? options.lead, input, async (adapter) => ({
        status: 'done',
        result: await adapter.openPr(input),
      })),
    markDraft: (pr, draft, input) =>
      call(
        'markDraft',
        pr.repo,
        [pr, draft, input ?? null],
        async (adapter) => ({
          status: 'done',
          result: await adapter.markDraft(pr, draft, input),
        }),
      ),
    waitForCi: (pr, input) =>
      call('waitForCi', pr.repo, [pr, input], (adapter) =>
        adapter.waitForCi(pr, input),
      ),
    retryFailedJobs: (pr) =>
      call('retryFailedJobs', pr.repo, pr, async (adapter) => ({
        status: 'done',
        result: await adapter.retryFailedJobs(pr),
      })),
    updateBranch: (pr) =>
      call('updateBranch', pr.repo, pr, (adapter) => adapter.updateBranch(pr)),
    armAutoMerge: (pr, approval: ApprovedCheckpoint) =>
      // The capability itself is deliberately neither persisted nor hashed.
      // Its validity separates a rejected/stale call from a prior valid arm.
      call(
        'armAutoMerge',
        pr.repo,
        [pr, { approved: options.approvals(approval) }],
        (adapter) => {
          if (!options.approvals(approval))
            throw refuse(
              pr.repo,
              'not_approved',
              'Auto-merge requires an approved Checkpoint from this Boot.',
              'Wait for ctx.checkpoint to return approve, then arm this PR/MR.',
              pr,
            );
          return adapter.armAutoMerge(pr);
        },
      ),
    reviewThreads: (pr) =>
      call('reviewThreads', pr.repo, pr, async (adapter) => ({
        status: 'done',
        result: await adapter.reviewThreads(pr),
      })),
    replyToThread: (thread, body) =>
      call(
        'replyToThread',
        thread.pr.repo,
        [thread, body],
        async (adapter) => ({
          status: 'done',
          result: await adapter.replyToThread(thread, body, options.runId),
        }),
      ),
  };
}
