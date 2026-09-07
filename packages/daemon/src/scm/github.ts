import { z } from 'zod';
import type {
  CiResult,
  FailedJob,
  MergeResult,
  OpenPrOptions,
  ScmPr as Pr,
  ReviewThread,
  UpdateBranchResult,
} from '@rocky/sdk';
import type { StepOutcome } from '../run/replay.js';
import { ScmError, ScmHttp, refuse, type ScmAdapterOptions } from './http.js';
import { coalesceReply, replyIntent, replyScope } from './reply.js';
import { probeGitHub } from './probe.js';

const ref = z.object({
  ref: z.string(),
  sha: z.string().optional(),
  repo: z.object({ full_name: z.string() }).nullable(),
});
const pullSchema = z.object({
  node_id: z.string(),
  number: z.number().int(),
  html_url: z.string(),
  head: ref.extend({ sha: z.string() }),
  base: ref,
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  draft: z.boolean(),
});
const checkSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  details_url: z.string().nullable(),
  output: z
    .object({
      summary: z.string().nullable(),
      text: z.string().nullable().optional(),
    })
    .optional(),
});
const statusSchema = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
});
const runSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  conclusion: z.string().nullable(),
  steps: z
    .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
    .default([]),
});
const successful = (conclusion: string | null) =>
  ['success', 'neutral', 'skipped'].includes(conclusion ?? '');
const mergeSchema = z.object({
  node: z.object({
    id: z.string(),
    headRefOid: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    isDraft: z.boolean(),
    mergeStateStatus: z.string(),
    reviewDecision: z.string().nullable(),
    isMergeQueueEnabled: z.boolean(),
    isInMergeQueue: z.boolean(),
    autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
    repository: z.object({
      autoMergeAllowed: z.boolean(),
      squashMergeAllowed: z.boolean(),
      mergeCommitAllowed: z.boolean(),
      rebaseMergeAllowed: z.boolean(),
    }),
  }),
});
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const commentsSchema = z.object({
  nodes: z.array(z.object({ body: z.string() })),
  pageInfo,
});
const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  isResolved: z.boolean(),
  comments: commentsSchema,
});
const notesResultSchema = z.object({
  node: z.object({ isResolved: z.boolean(), comments: commentsSchema }),
});
const threadsResultSchema = z.object({
  node: z.object({
    reviewThreads: z.object({ nodes: z.array(threadSchema), pageInfo }),
  }),
});

export function createGitHubScm(options: ScmAdapterOptions) {
  const http = new ScmHttp(options, 'https://api.github.com');
  const root = `/repos/${options.repo.project.split('/').map(encodeURIComponent).join('/')}`;
  const owner = options.repo.project.split('/')[0];
  const handle = (pull: z.infer<typeof pullSchema>): Pr => ({
    repo: options.repo.id,
    id: pull.node_id,
    number: pull.number,
    url: pull.html_url,
    sourceBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    headSha: pull.head.sha,
    state: pull.merged_at ? 'merged' : pull.state,
    draft: pull.draft,
  });
  const validateOwnership = (pull: z.infer<typeof pullSchema>) => {
    if (
      pull.head.repo?.full_name !== options.repo.project ||
      pull.base.repo?.full_name !== options.repo.project
    )
      throw refuse(
        options.repo.id,
        'not_open',
        'PR source or base repository does not belong to this Run member.',
        'Use a same-repository PR for this Run member.',
      );
  };
  const validate = (pr: Pr) => {
    if (
      pr.repo !== options.repo.id ||
      pr.sourceBranch !== options.branch ||
      pr.baseBranch !== options.repo.baseBranch
    )
      throw refuse(
        options.repo.id,
        'not_open',
        'PR does not belong to this Run member.',
        'Use the handle returned by openPr.',
      );
  };
  const read = async (pr: Pr) => {
    validate(pr);
    const pull = await http.request(
      'GET',
      `${root}/pulls/${pr.number}`,
      pullSchema,
    );
    validateOwnership(pull);
    const current = handle(pull);
    if (
      current.id !== pr.id ||
      current.sourceBranch !== pr.sourceBranch ||
      current.baseBranch !== pr.baseBranch
    )
      throw refuse(
        options.repo.id,
        'not_open',
        'PR identity changed.',
        'Inspect the source and target branches.',
        current,
      );
    return current;
  };
  const checkHead = (pr: Pr, current: Pr) => {
    if (current.headSha !== pr.headSha)
      throw refuse(
        options.repo.id,
        'head_changed',
        'The source head changed.',
        'Adopt the current head and rerun the bounded CI/merge iteration.',
        current,
      );
  };
  const notes = async (id: string) => {
    const bodies: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const { node }: z.infer<typeof notesResultSchema> = await http.graphql(
        `query Notes($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequestReviewThread {
        isResolved comments(first: 100, after: $cursor) { nodes { body } pageInfo { hasNextPage endCursor } }
      } } }`,
        { id, cursor },
        notesResultSchema,
      );
      bodies.push(...node.comments.nodes.map((note) => note.body));
      if (!node.comments.pageInfo.hasNextPage)
        return { bodies, resolved: node.isResolved };
      if (
        !node.comments.pageInfo.endCursor ||
        node.comments.pageInfo.endCursor === cursor
      )
        break;
      cursor = node.comments.pageInfo.endCursor;
    }
    throw refuse(
      options.repo.id,
      'invalid_response',
      'Thread pagination did not finish.',
      'Verify the GraphQL pagination response.',
    );
  };
  const findOpenPr = async () => {
    const query = new URLSearchParams({
      state: 'all',
      head: `${owner}:${options.branch}`,
      base: options.repo.baseBranch,
      per_page: '100',
    });
    let terminal: Pr | undefined;
    for (let page = 1; ; page++) {
      const pulls = await http.request(
        'GET',
        `${root}/pulls?${query}&page=${page}`,
        z.array(pullSchema),
      );
      const matches = pulls.filter(
        (pull) =>
          pull.head.repo?.full_name === options.repo.project &&
          pull.base.repo?.full_name === options.repo.project &&
          pull.head.ref === options.branch &&
          pull.base.ref === options.repo.baseBranch,
      );
      const open = matches.find((pull) => handle(pull).state === 'open');
      if (open) return handle(open);
      terminal ??= matches.length ? handle(matches[0]) : undefined;
      if (pulls.length < 100) return terminal;
      if (page === 1000)
        throw refuse(
          options.repo.id,
          'unavailable',
          'PR pagination exceeded its bound.',
          'Narrow the branch identity.',
        );
    }
  };
  return {
    repo: options.repo,
    signal: options.signal,
    probe: (signal: AbortSignal) => probeGitHub(options, http, root, signal),
    async openPr(input: OpenPrOptions): Promise<Pr> {
      const existing = await findOpenPr();
      if (existing) {
        if (existing.state !== 'open')
          throw refuse(
            options.repo.id,
            'not_open',
            'A matching prior PR is closed or merged.',
            'Inspect that PR; do not create a second review for this branch.',
            existing,
          );
        return existing;
      }
      try {
        return handle(
          await http.request('POST', `${root}/pulls`, pullSchema, {
            title: input.title,
            body: input.body,
            head: options.branch,
            base: options.repo.baseBranch,
            draft: input.draft ?? true,
          }),
        );
      } catch (error) {
        if (
          !(error instanceof ScmError) ||
          ![409, 422].includes(error.status ?? 0)
        )
          throw error;
        // A concurrent creator may have won after the bounded lookup. Re-read
        // once, then preserve the original refusal rather than retrying POST.
        const recovered = await findOpenPr();
        if (recovered) {
          if (recovered.state !== 'open')
            throw refuse(
              options.repo.id,
              'not_open',
              'A matching prior PR is closed or merged.',
              'Inspect that PR; do not create a second review for this branch.',
              recovered,
            );
          return recovered;
        }
        throw error;
      }
    },
    async markDraft(
      pr: Pr,
      draft: boolean,
      input?: { body?: string },
    ): Promise<Pr> {
      const current = await read(pr);
      if (current.state !== 'open')
        throw refuse(
          options.repo.id,
          'not_open',
          'PR is not open.',
          'Do not reopen a completed PR.',
          current,
        );
      if (input?.body !== undefined) {
        const patched = await http.request(
          'PATCH',
          `${root}/pulls/${pr.number}`,
          pullSchema,
          {
            body: input.body,
          },
        );
        validateOwnership(patched);
        const returned = handle(patched);
        if (
          returned.id !== current.id ||
          returned.sourceBranch !== current.sourceBranch ||
          returned.baseBranch !== current.baseBranch
        )
          throw refuse(
            options.repo.id,
            'invalid_response',
            'PR content mutation returned a different PR identity.',
            'Inspect the PR identity before retrying.',
            returned,
          );
      }
      if (current.draft !== draft) {
        const operation = draft
          ? 'convertPullRequestToDraft'
          : 'markPullRequestReadyForReview';
        const inputType = draft
          ? 'ConvertPullRequestToDraftInput'
          : 'MarkPullRequestReadyForReviewInput';
        const verified = await read(pr);
        const response = await http.graphql(
          `mutation Draft($input: ${inputType}!) { ${operation}(input: $input) { pullRequest { id } } }`,
          { input: { pullRequestId: verified.id } },
          z.object({
            [operation]: z.object({
              pullRequest: z.object({ id: z.string() }),
            }),
          }),
        );
        if (response[operation].pullRequest.id !== verified.id)
          throw refuse(
            options.repo.id,
            'invalid_response',
            'Draft mutation returned a different PR identity.',
            'Inspect the PR identity before retrying.',
            verified,
          );
      }
      const updated = await read(pr);
      if (updated.draft !== draft)
        throw refuse(
          options.repo.id,
          'draft_status',
          'Native draft readback disagrees with the requested state.',
          'Inspect the PR draft state and API support.',
          updated,
        );
      return updated;
    },
    async waitForCi(
      pr: Pr,
      input: { logTailLines: number },
    ): Promise<StepOutcome<CiResult>> {
      if (
        !Number.isSafeInteger(input.logTailLines) ||
        input.logTailLines < 0 ||
        input.logTailLines > 10000
      )
        throw new Error('logTailLines must be between 0 and 10000');
      checkHead(pr, await read(pr));
      const checks = await http.list(
        `${root}/commits/${encodeURIComponent(pr.headSha)}/check-runs?filter=latest`,
        checkSchema,
        'check_runs',
      );
      const statuses = await http.list(
        `${root}/commits/${encodeURIComponent(pr.headSha)}/statuses`,
        statusSchema,
      );
      const runs = await http.list(
        `${root}/actions/runs?head_sha=${encodeURIComponent(pr.headSha)}`,
        runSchema,
        'workflow_runs',
      );
      const latest = [
        ...new Map(
          statuses.toReversed().map((status) => [status.context, status]),
        ).values(),
      ];
      if (
        checks.some((check) => check.head_sha !== pr.headSha) ||
        runs.some((run) => run.head_sha !== pr.headSha)
      )
        throw refuse(
          options.repo.id,
          'head_changed',
          'CI reports a different head.',
          'Wait for CI on the current source head.',
          pr,
        );
      const failedJobs: FailedJob[] = [];
      for (const run of runs.filter(
        (run) => run.status === 'completed' && !successful(run.conclusion),
      )) {
        const jobs = await http.list(
          `${root}/actions/runs/${run.id}/jobs?filter=latest`,
          jobSchema,
          'jobs',
        );
        const failed = jobs.filter(
          (job) => job.conclusion && !successful(job.conclusion),
        );
        for (const job of failed)
          failedJobs.push({
            id: String(job.id),
            name: job.name,
            failedSteps: job.steps
              .filter((step) => step.conclusion && !successful(step.conclusion))
              .map((step) => step.name),
            logTail: await http.logTail(
              `${root}/actions/jobs/${job.id}/logs`,
              input.logTailLines,
            ),
          });
        if (!failed.length)
          failedJobs.push({
            id: String(run.id),
            name: run.name,
            failedSteps: [],
            logTail: '',
          });
      }
      for (const check of checks.filter(
        (check) =>
          check.status === 'completed' && !successful(check.conclusion),
      )) {
        if (
          runs.some((run) =>
            check.details_url?.includes(`/actions/runs/${run.id}/`),
          )
        )
          continue;
        failedJobs.push({
          id: String(check.id),
          name: check.name,
          failedSteps: [],
          logTail: input.logTailLines
            ? (check.output?.text ?? check.output?.summary ?? '')
                .split('\n')
                .slice(-input.logTailLines)
                .join('\n')
            : '',
        });
      }
      for (const status of latest.filter((status) =>
        ['error', 'failure'].includes(status.state),
      ))
        failedJobs.push({
          id: String(status.id),
          name: status.context,
          failedSteps: [],
          logTail: '',
        });
      checkHead(pr, await read(pr));
      if (failedJobs.length)
        return {
          status: 'done',
          result: { status: 'failed', headSha: pr.headSha, failedJobs },
        };
      if (
        checks.length + latest.length + runs.length === 0 ||
        checks.some((check) => check.status !== 'completed') ||
        latest.some((status) => status.state !== 'success') ||
        runs.some((run) => run.status !== 'completed')
      )
        return { status: 'waiting' };
      return {
        status: 'done',
        result: { status: 'passed', headSha: pr.headSha, failedJobs: [] },
      };
    },
    async armAutoMerge(pr: Pr): Promise<StepOutcome<MergeResult>> {
      // A GraphQL node ID is not authority. Bind it to a fresh repository
      // REST read before any queue/auto-merge mutation.
      const verified = await read(pr);
      const { node } = await http.graphql(
        `query Merge($id: ID!) { node(id: $id) { ... on PullRequest {
        id headRefOid state isDraft mergeStateStatus reviewDecision isMergeQueueEnabled isInMergeQueue
        autoMergeRequest { enabledAt } repository { autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed }
      } } }`,
        { id: verified.id },
        mergeSchema,
      );
      const current: Pr = {
        ...verified,
        headSha: node.headRefOid,
        draft: node.isDraft,
        state:
          node.state === 'MERGED'
            ? 'merged'
            : node.state === 'CLOSED'
              ? 'closed'
              : 'open',
      };
      if (node.id !== verified.id)
        throw refuse(
          options.repo.id,
          'not_open',
          'PR identity changed.',
          'Inspect the PR identity.',
        );
      if (current.state === 'merged')
        return { status: 'done', result: { status: 'merged', pr: current } };
      checkHead(pr, current);
      if (current.state !== 'open')
        throw refuse(
          options.repo.id,
          'not_open',
          'PR was closed without merging.',
          'Inspect the closed PR; do not report it as merged.',
          current,
        );
      if (current.draft)
        throw refuse(
          options.repo.id,
          'draft_status',
          'PR is still a draft.',
          'Complete reviews and mark ready before arming.',
          current,
        );
      if (node.mergeStateStatus === 'DIRTY')
        throw refuse(
          options.repo.id,
          'conflict',
          'PR has merge conflicts.',
          'Resolve conflicts in the bounded merge loop.',
          current,
        );
      if (node.mergeStateStatus === 'BEHIND')
        throw refuse(
          options.repo.id,
          'need_rebase',
          'PR base moved.',
          'Update the branch and rerun CI.',
          current,
        );
      if (node.mergeStateStatus === 'UNSTABLE')
        throw refuse(
          options.repo.id,
          'ci_must_pass',
          'PR checks are not passing.',
          'Inspect CI and repair or retry failed jobs.',
          current,
        );
      if (node.mergeStateStatus === 'UNKNOWN') return { status: 'waiting' };
      if (
        node.isInMergeQueue ||
        (!node.isMergeQueueEnabled && node.autoMergeRequest)
      )
        return { status: 'waiting' };
      if (!node.isMergeQueueEnabled && !node.repository.autoMergeAllowed)
        throw refuse(
          options.repo.id,
          'unsupported',
          'Repository auto-merge is disabled.',
          'Ask a maintainer to verify auto-merge support, or merge manually; Rocky remains Parked.',
          current,
        );
      if (node.isMergeQueueEnabled) {
        const response = await http.graphql(
          'mutation Arm($input: EnqueuePullRequestInput!) { enqueuePullRequest(input: $input) { mergeQueueEntry { id pullRequest { id } } } }',
          {
            input: {
              pullRequestId: verified.id,
              expectedHeadOid: pr.headSha,
            },
          },
          z.object({
            enqueuePullRequest: z.object({
              mergeQueueEntry: z
                .object({
                  id: z.string(),
                  pullRequest: z.object({ id: z.string() }),
                })
                .nullable(),
            }),
          }),
        );
        const entry = response.enqueuePullRequest.mergeQueueEntry;
        if (!entry || entry.pullRequest.id !== verified.id)
          throw refuse(
            options.repo.id,
            'invalid_response',
            'Merge-queue enrollment did not return the requested PR.',
            'Inspect the merge-queue entry before retrying.',
            current,
          );
      } else {
        const mergeMethod = node.repository.squashMergeAllowed
          ? 'SQUASH'
          : node.repository.mergeCommitAllowed
            ? 'MERGE'
            : node.repository.rebaseMergeAllowed
              ? 'REBASE'
              : undefined;
        if (!mergeMethod)
          throw refuse(
            options.repo.id,
            'unsupported',
            'No platform merge method is enabled.',
            'Ask a maintainer to verify merge policy.',
            current,
          );
        const response = await http.graphql(
          'mutation Arm($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { pullRequest { id } } }',
          {
            input: {
              pullRequestId: verified.id,
              expectedHeadOid: pr.headSha,
              mergeMethod,
            },
          },
          z.object({
            enablePullRequestAutoMerge: z.object({
              pullRequest: z.object({ id: z.string() }),
            }),
          }),
        );
        if (response.enablePullRequestAutoMerge.pullRequest.id !== verified.id)
          throw refuse(
            options.repo.id,
            'invalid_response',
            'Auto-merge mutation returned a different PR identity.',
            'Inspect the PR identity before retrying.',
            current,
          );
      }
      return { status: 'waiting' };
    },
    async updateBranch(pr: Pr): Promise<StepOutcome<UpdateBranchResult>> {
      validate(pr);
      const pull = await http.request(
        'GET',
        `${root}/pulls/${pr.number}`,
        pullSchema.extend({ mergeable_state: z.string() }),
      );
      validateOwnership(pull);
      const current = handle(pull);
      if (
        current.id !== pr.id ||
        current.sourceBranch !== pr.sourceBranch ||
        current.baseBranch !== pr.baseBranch ||
        current.state !== 'open'
      )
        throw refuse(
          options.repo.id,
          'not_open',
          'PR is not open or its identity changed.',
          'Inspect the PR before updating.',
          current,
        );
      if (pull.mergeable_state === 'dirty')
        return { status: 'done', result: { status: 'conflict', pr: current } };
      if (pull.mergeable_state === 'unknown') return { status: 'waiting' };
      if (pull.mergeable_state !== 'behind')
        return {
          status: 'done',
          result: {
            status: current.headSha === pr.headSha ? 'clean' : 'updated',
            pr: current,
          },
        };
      checkHead(pr, current);
      try {
        await http.request(
          'PUT',
          `${root}/pulls/${pr.number}/update-branch`,
          z.object({ message: z.string() }),
          { expected_head_sha: pr.headSha },
        );
      } catch (error) {
        if (error instanceof ScmError && [409, 422].includes(error.status ?? 0))
          throw refuse(
            options.repo.id,
            'conflict',
            'Platform refused the guarded branch update.',
            'Re-read the PR head and resolve conflicts before retrying.',
            current,
          );
        throw error;
      }
      return { status: 'waiting' };
    },
    async retryFailedJobs(pr: Pr): Promise<void> {
      const initial = await read(pr);
      if (initial.state !== 'open')
        throw refuse(
          options.repo.id,
          'not_open',
          'PR is not open.',
          'Inspect the PR before retrying failed jobs.',
          initial,
        );
      checkHead(pr, initial);
      const runs = await http.list(
        `${root}/actions/runs?head_sha=${encodeURIComponent(pr.headSha)}`,
        runSchema,
        'workflow_runs',
      );
      for (const run of runs.filter(
        (run) =>
          run.head_sha === pr.headSha &&
          run.status === 'completed' &&
          !successful(run.conclusion),
      )) {
        const current = await read(pr);
        if (current.state !== 'open')
          throw refuse(
            options.repo.id,
            'not_open',
            'PR is not open.',
            'Inspect the PR before retrying failed jobs.',
            current,
          );
        checkHead(pr, current);
        await http.request(
          'POST',
          `${root}/actions/runs/${run.id}/rerun-failed-jobs`,
          z.object({}),
        );
      }
    },
    async reviewThreads(pr: Pr): Promise<ReviewThread[]> {
      const verified = await read(pr);
      const result: ReviewThread[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 1000; page++) {
        const { node }: z.infer<typeof threadsResultSchema> =
          await http.graphql(
            `query Threads($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequest {
          reviewThreads(first: 100, after: $cursor) { nodes { id path line isResolved comments(first: 100) { nodes { body } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }
        } } }`,
            { id: verified.id, cursor },
            threadsResultSchema,
          );
        for (const thread of node.reviewThreads.nodes) {
          const bodies = thread.comments.pageInfo.hasNextPage
            ? (await notes(thread.id)).bodies
            : thread.comments.nodes.map((note) => note.body);
          result.push({
            pr: verified,
            id: thread.id,
            path: thread.path,
            ...(thread.line === null ? {} : { line: thread.line }),
            body: bodies.join('\n\n'),
            resolved: thread.isResolved,
          });
        }
        if (!node.reviewThreads.pageInfo.hasNextPage) return result;
        if (
          !node.reviewThreads.pageInfo.endCursor ||
          node.reviewThreads.pageInfo.endCursor === cursor
        )
          break;
        cursor = node.reviewThreads.pageInfo.endCursor;
      }
      throw refuse(
        options.repo.id,
        'invalid_response',
        'Review pagination did not finish.',
        'Verify the GraphQL pagination response.',
      );
    },
    async replyToThread(
      thread: ReviewThread,
      body: string,
      runId: string,
    ): Promise<void> {
      const current = await read(thread.pr);
      const actual = (await this.reviewThreads(current)).find(
        (candidate) => candidate.id === thread.id,
      );
      if (!actual)
        throw refuse(
          options.repo.id,
          'not_open',
          'Review thread does not belong to the current PR.',
          'Re-read review threads from this PR before replying.',
          current,
        );
      const existing = await notes(actual.id);
      const intent = replyIntent(
        actual,
        body,
        runId,
        existing.bodies,
        options.token,
      );
      if (!intent.exists)
        await coalesceReply(
          replyScope(http.root, options.repo.project, actual.id, options.token),
          intent.body,
          async () => {
            try {
              await http.graphql(
                'mutation Reply($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { id } } }',
                {
                  input: {
                    pullRequestReviewThreadId: actual.id,
                    body: intent.body,
                  },
                },
                z.object({
                  addPullRequestReviewThreadReply: z.object({
                    comment: z.object({ id: z.string() }),
                  }),
                }),
              );
            } catch (error) {
              if (!(
                error instanceof ScmError &&
                [409, 422].includes(error.status ?? 0)
              ))
                throw error;
              const recovered = await notes(actual.id);
              if (
                !replyIntent(
                  actual,
                  body,
                  runId,
                  recovered.bodies,
                  options.token,
                ).exists
              )
                throw error;
            }
          },
        );
      // GitHub offers no CAS resolution bound to this exact discussion
      // revision. A human or platform automation must resolve it safely.
    },
  };
}
