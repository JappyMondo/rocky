import { z } from 'zod';
import { createHash } from 'node:crypto';
import type {
  CiResult,
  FailedJob,
  MergeResult,
  OpenPrOptions,
  ScmPr as Pr,
  ReviewThread,
  ScmRefusalReason,
  UpdateBranchResult,
} from '@rocky/sdk';
import type { StepOutcome } from '../run/replay.js';
import { ScmError, ScmHttp, refuse, type ScmAdapterOptions } from './http.js';
import { coalesceReply, replyIntent, replyScope } from './reply.js';
import { probeGitLab } from './probe.js';

const pipelineSchema = z.object({
  id: z.number().int(),
  sha: z.string(),
  ref: z.string(),
  status: z.string(),
});
const jobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  allow_failure: z.boolean(),
});
const mrSchema = z.object({
  id: z.number().int(),
  iid: z.number().int(),
  project_id: z.number().int(),
  source_project_id: z.number().int().nullable(),
  target_project_id: z.number().int(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string(),
  title: z.string(),
  draft: z.boolean(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  web_url: z.string(),
  detailed_merge_status: z.string(),
  rebase_in_progress: z.boolean().optional(),
  merge_error: z.string().nullable().optional(),
  merge_when_pipeline_succeeds: z.boolean().optional(),
  head_pipeline: pipelineSchema.nullable().optional(),
});
const trainSchema = z.object({
  id: z.number(),
  status: z.string(),
  target_branch: z.string(),
  merge_request: z.object({ id: z.number(), iid: z.number() }),
  pipeline: pipelineSchema.nullable(),
});
const projectSchema = z.object({
  id: z.number().int(),
  merge_trains_enabled: z.boolean().optional(),
});
const discussionSchema = z.object({
  id: z.string(),
  notes: z.array(
    z.object({
      id: z.number(),
      body: z.string(),
      system: z.boolean(),
      resolvable: z.boolean(),
      resolved: z.boolean().optional(),
      position: z
        .object({
          new_path: z.string().optional(),
          old_path: z.string().optional(),
          new_line: z.number().nullable().optional(),
          old_line: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
});
const mergeReasons = z.enum([
  'approvals_syncing',
  'blocked_status',
  'checking',
  'ci_must_pass',
  'ci_still_running',
  'commits_status',
  'conflict',
  'discussions_not_resolved',
  'draft_status',
  'external_status_checks',
  'jira_association_missing',
  'merge_request_blocked',
  'merge_time',
  'need_rebase',
  'not_approved',
  'not_open',
  'requested_changes',
  'preparing',
  'status_checks_must_pass',
  'unchecked',
  'security_policy_violations',
  'security_policy_pipeline_check',
  'title_regex',
]);
const readyTitle = (title: string) =>
  title.replace(
    /^(?:(?:draft|wip)\s*:|\[(?:draft|wip)\]|\((?:draft|wip)\))\s*/i,
    '',
  );

// A successful arm is remembered only as a bounded, disposable process-local
// optimization. A restart may issue an idempotent arm once; the journal and
// platform readback remain the durable recovery boundary.
const armedHeads = new Set<string>();

export function createGitLabScm(options: ScmAdapterOptions) {
  const http = new ScmHttp(options, 'https://gitlab.com/api/v4');
  const root = `/projects/${encodeURIComponent(options.repo.project)}`;
  let projectPromise: Promise<z.infer<typeof projectSchema>> | undefined;
  const project = () =>
    (projectPromise ??= http.request('GET', root, projectSchema));
  const handle = (mr: z.infer<typeof mrSchema>): Pr => ({
    repo: options.repo.id,
    id: String(mr.id),
    number: mr.iid,
    url: mr.web_url,
    sourceBranch: mr.source_branch,
    baseBranch: mr.target_branch,
    headSha: mr.sha,
    state:
      mr.state === 'merged'
        ? 'merged'
        : mr.state === 'closed'
          ? 'closed'
          : 'open',
    draft: mr.draft,
  });
  const validate = (pr: Pr) => {
    if (
      pr.repo !== options.repo.id ||
      pr.sourceBranch !== options.branch ||
      pr.baseBranch !== options.repo.baseBranch
    )
      throw refuse(
        options.repo.id,
        'not_open',
        'MR does not belong to this Run member.',
        'Use the handle returned by openPr.',
      );
  };
  const validateProjectMr = (
    mr: z.infer<typeof mrSchema>,
    configuredProjectId: number,
  ) => {
    if (
      mr.project_id !== configuredProjectId ||
      mr.source_project_id !== configuredProjectId ||
      mr.target_project_id !== configuredProjectId
    )
      throw refuse(
        options.repo.id,
        'invalid_response',
        'MR response does not belong to the configured project.',
        'Inspect the MR source and target project identities before retrying.',
        handle(mr),
      );
    return mr;
  };
  const read = async (pr: Pr) => {
    validate(pr);
    const [configuredProject, mr] = await Promise.all([
      project(),
      http.request(
        'GET',
        `${root}/merge_requests/${pr.number}?include_rebase_in_progress=true`,
        mrSchema,
      ),
    ]);
    validateProjectMr(mr, configuredProject.id);
    if (
      String(mr.id) !== pr.id ||
      mr.source_branch !== pr.sourceBranch ||
      mr.target_branch !== pr.baseBranch ||
      mr.source_project_id !== mr.target_project_id
    )
      throw refuse(
        options.repo.id,
        'not_open',
        'MR identity changed or its source is not this member.',
        'Inspect the source and target project.',
        handle(mr),
      );
    return mr;
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
  const checkMutationMr = async (
    value: z.infer<typeof mrSchema>,
    expected: Pr,
  ) => {
    validateProjectMr(value, (await project()).id);
    const returned = handle(value);
    if (
      returned.id !== expected.id ||
      returned.sourceBranch !== expected.sourceBranch ||
      returned.baseBranch !== expected.baseBranch ||
      returned.headSha !== expected.headSha
    )
      throw refuse(
        options.repo.id,
        'invalid_response',
        'Merge mutation returned a different MR identity or source head.',
        'Inspect the MR identity and source head before retrying.',
        returned,
      );
  };
  const features = async () => {
    const server = await http.request(
      'GET',
      '/version',
      z.object({ version: z.string() }),
    );
    const match = /^(\d+)\.(\d+)\./.exec(server.version);
    if (
      !match ||
      Number(match[1]) < 17 ||
      (Number(match[1]) === 17 && Number(match[2]) < 11)
    )
      throw refuse(
        options.repo.id,
        'unsupported',
        `GitLab ${server.version} has unqualified auto_merge semantics (requires 17.11 or later).`,
        'Ask a maintainer to verify a supported server; no merge mutation will be used as a probe.',
      );
    const configuredProject = await project();
    if (configuredProject.merge_trains_enabled === undefined)
      throw refuse(
        options.repo.id,
        'permission_unknown',
        'GitLab merge-train configuration is not visible.',
        'Ask a maintainer to verify the project feature/tier and API visibility; do not assume ordinary merge routing.',
      );
    return {
      version: server.version,
      trains: configuredProject.merge_trains_enabled,
    };
  };
  const train = async (pr: Pr) => {
    try {
      const value = await http.request(
        'GET',
        `${root}/merge_trains/merge_requests/${pr.number}`,
        trainSchema,
      );
      if (
        value.merge_request.id !== Number(pr.id) ||
        value.merge_request.iid !== pr.number ||
        value.target_branch !== pr.baseBranch
      )
        throw refuse(
          options.repo.id,
          'invalid_response',
          'Merge-train identity does not match the MR.',
          'Inspect the train and MR identities.',
        );
      return value;
    } catch (error) {
      if (error instanceof ScmError && error.status === 404) return undefined;
      throw error;
    }
  };
  const currentPipeline = async (pr: Pr) => {
    const mr = await read(pr);
    checkHead(pr, handle(mr));
    const pipelines = await http.list(
      `${root}/merge_requests/${pr.number}/pipelines`,
      pipelineSchema,
    );
    const pipeline = mr.head_pipeline
      ? pipelines.find((pipeline) => pipeline.id === mr.head_pipeline?.id)
      : pipelines
          .filter((pipeline) => pipeline.sha === pr.headSha)
          .sort((a, b) => b.id - a.id)[0];
    if (!pipeline) return undefined;
    if (pipeline.ref === `refs/merge-requests/${pr.number}/train`) {
      const entry = await train(pr);
      if (!entry || entry.pipeline?.id !== pipeline.id)
        throw refuse(
          options.repo.id,
          'train_pipeline_dropped',
          'The MR was removed from its merge-train pipeline.',
          'Repair the failure and re-add the MR in a new bounded merge iteration; never retry the dropped train pipeline.',
          handle(mr),
        );
    }
    if (pipeline.sha !== pr.headSha) {
      if (
        ![
          `refs/merge-requests/${pr.number}/merge`,
          `refs/merge-requests/${pr.number}/train`,
        ].includes(pipeline.ref)
      )
        throw refuse(
          options.repo.id,
          'head_changed',
          'The MR pipeline belongs to an older source head.',
          'Wait for a pipeline for the current head.',
          handle(mr),
        );
      const commit = await http.request(
        'GET',
        `${root}/repository/commits/${encodeURIComponent(pipeline.sha)}`,
        z.object({ parent_ids: z.array(z.string()) }),
      );
      if (!commit.parent_ids.includes(pr.headSha))
        throw refuse(
          options.repo.id,
          'head_changed',
          'The synthetic pipeline commit does not include the current source head.',
          'Wait for a fresh merged-results/train pipeline.',
          handle(mr),
        );
    }
    return pipeline;
  };
  return {
    repo: options.repo,
    signal: options.signal,
    probe: (signal: AbortSignal) => probeGitLab(options, http, root, signal),
    async openPr(input: OpenPrOptions): Promise<Pr> {
      const query = new URLSearchParams({
        state: 'all',
        source_branch: options.branch,
        target_branch: options.repo.baseBranch,
      });
      const configuredProject = await project();
      const mrs = await http.list(`${root}/merge_requests?${query}`, mrSchema);
      mrs.forEach((mr) => validateProjectMr(mr, configuredProject.id));
      const matches = mrs.filter(
        (mr) =>
          mr.source_project_id === mr.target_project_id &&
          mr.source_branch === options.branch &&
          mr.target_branch === options.repo.baseBranch,
      );
      const open = matches.find((mr) => mr.state === 'opened');
      if (open) return handle(open);
      if (matches.length)
        throw refuse(
          options.repo.id,
          'not_open',
          'A matching prior MR is closed or merged.',
          'Inspect that MR; do not create a second review for this branch.',
          handle(matches[0]),
        );
      const title = `${input.draft === false ? '' : 'Draft: '}${readyTitle(input.title)}`;
      try {
        const created = await http.request(
          'POST',
          `${root}/merge_requests`,
          mrSchema,
          {
            title,
            description: input.body,
            source_branch: options.branch,
            target_branch: options.repo.baseBranch,
          },
        );
        validateProjectMr(created, configuredProject.id);
        if (
          created.source_branch !== options.branch ||
          created.target_branch !== options.repo.baseBranch ||
          created.state !== 'opened'
        )
          throw refuse(
            options.repo.id,
            'invalid_response',
            'MR creation returned a different branch identity or a non-open MR.',
            'Inspect the created MR before retrying.',
            handle(created),
          );
        return handle(created);
      } catch (error) {
        if (
          !(error instanceof ScmError) ||
          ![409, 422].includes(error.status ?? 0)
        )
          throw error;
        const recovered = await http.list(
          `${root}/merge_requests?${query}`,
          mrSchema,
        );
        recovered.forEach((mr) => validateProjectMr(mr, configuredProject.id));
        const matches = recovered.filter(
          (candidate) =>
            candidate.source_project_id === candidate.target_project_id &&
            candidate.source_branch === options.branch &&
            candidate.target_branch === options.repo.baseBranch,
        );
        const open = matches.find((candidate) => candidate.state === 'opened');
        if (open) return handle(open);
        if (matches.length)
          throw refuse(
            options.repo.id,
            'not_open',
            'A matching prior MR is closed or merged.',
            'Inspect that MR; do not create a second review for this branch.',
            handle(matches[0]),
          );
        throw error;
      }
    },
    async markDraft(
      pr: Pr,
      draft: boolean,
      input?: { body?: string },
    ): Promise<Pr> {
      const mr = await read(pr);
      if (mr.state !== 'opened')
        throw refuse(
          options.repo.id,
          'not_open',
          'MR is not open.',
          'Do not reopen a completed MR.',
          handle(mr),
        );
      if (mr.draft !== draft || input?.body !== undefined) {
        const response = await http.request(
          'PUT',
          `${root}/merge_requests/${pr.number}`,
          mrSchema,
          {
            title: `${draft ? 'Draft: ' : ''}${readyTitle(mr.title)}`,
            ...(input?.body === undefined ? {} : { description: input.body }),
          },
        );
        await checkMutationMr(response, handle(mr));
      }
      const updated = handle(await read(pr));
      if (updated.draft !== draft)
        throw refuse(
          options.repo.id,
          'draft_status',
          'Native draft readback disagrees with the requested state.',
          'Inspect the MR draft state and API support.',
          updated,
        );
      return updated;
    },
    async updateBranch(pr: Pr): Promise<StepOutcome<UpdateBranchResult>> {
      const mr = await read(pr);
      const current = handle(mr);
      if (mr.state !== 'opened')
        throw refuse(
          options.repo.id,
          'not_open',
          'MR is not open.',
          'Inspect the MR before updating.',
          current,
        );
      if (mr.rebase_in_progress) return { status: 'waiting' };
      if (mr.merge_error || mr.detailed_merge_status === 'conflict')
        return { status: 'done', result: { status: 'conflict', pr: current } };
      if (
        ['checking', 'preparing', 'unchecked'].includes(
          mr.detailed_merge_status,
        )
      )
        return { status: 'waiting' };
      if (mr.detailed_merge_status !== 'need_rebase')
        return {
          status: 'done',
          result: {
            status: current.headSha === pr.headSha ? 'clean' : 'updated',
            pr: current,
          },
        };
      checkHead(pr, current);
      try {
        // GitLab has no expected-SHA argument for rebase. Do not invent one.
        await http.request(
          'PUT',
          `${root}/merge_requests/${pr.number}/rebase`,
          z.object({ rebase_in_progress: z.boolean() }),
        );
      } catch (error) {
        if (!(error instanceof ScmError && error.status === 403)) throw error;
        // Rebase refusal can race a source push; do not offer a local fallback
        // for a source head that is no longer current.
        const reread = handle(await read(pr));
        checkHead(pr, reread);
        let branch;
        try {
          branch = await http.request(
            'GET',
            `${root}/repository/branches/${encodeURIComponent(pr.sourceBranch)}`,
            z.object({ name: z.string(), can_push: z.boolean().optional() }),
          );
        } catch (sourceError) {
          if (sourceError instanceof ScmError && sourceError.status === 404)
            throw refuse(
              options.repo.id,
              'source_missing',
              'The source branch is missing.',
              'Restore the source branch; no local merge fallback is safe.',
              current,
            );
          throw sourceError;
        }
        if (branch.name !== pr.sourceBranch || branch.can_push !== true)
          throw refuse(
            options.repo.id,
            branch.can_push === false
              ? 'permission_denied'
              : 'permission_unknown',
            'Rebase was refused and ordinary source push is not allowed or verified.',
            'Obtain source push permission; do not force-push or change protection.',
            current,
          );
        return {
          status: 'done',
          result: { status: 'local_base_merge_required', pr: reread },
        };
      }
      return { status: 'waiting' };
    },
    async armAutoMerge(pr: Pr): Promise<StepOutcome<MergeResult>> {
      const mr = await read(pr);
      const current = handle(mr);
      if (mr.state === 'merged')
        return { status: 'done', result: { status: 'merged', pr: current } };
      checkHead(pr, current);
      if (mr.state === 'locked') return { status: 'waiting' };
      if (mr.state !== 'opened')
        throw refuse(
          options.repo.id,
          'not_open',
          'MR was closed without merging.',
          'Inspect the MR; do not report it as merged.',
          current,
        );
      if (mr.draft)
        throw refuse(
          options.repo.id,
          'draft_status',
          'MR is still a draft.',
          'Complete reviews and mark ready before arming.',
          current,
        );
      const status = mergeReasons.safeParse(mr.detailed_merge_status);
      if (status.success) {
        const reason: ScmRefusalReason = status.data;
        if (['checking', 'preparing', 'unchecked'].includes(reason))
          return { status: 'waiting' };
        throw refuse(
          options.repo.id,
          reason,
          `GitLab reports ${reason}.`,
          'Repair the branch/CI in the bounded merge loop.',
          current,
        );
      }
      const support = await features();
      if (support.trains) {
        const entry = await train(pr);
        if (entry) {
          if (
            !['idle', 'fresh', 'merging'].includes(entry.status) ||
            (entry.pipeline &&
              ['failed', 'canceled'].includes(entry.pipeline.status))
          )
            throw refuse(
              options.repo.id,
              'train_pipeline_dropped',
              'The merge-train pipeline failed or was canceled.',
              'Do not retry that pipeline. Repair the failure and re-add the MR in a new bounded iteration.',
              current,
            );
          return { status: 'waiting' };
        }
      }
      // Feature/train reads can race closure, retargeting, draft conversion,
      // head changes, or a new detailed blocker. GitLab exposes no mutation
      // precondition, so revalidate the full mutation authority immediately.
      const armMr = await read(pr);
      const armCurrent = handle(armMr);
      if (armMr.state === 'merged')
        return { status: 'done', result: { status: 'merged', pr: armCurrent } };
      checkHead(pr, armCurrent);
      if (armMr.state === 'locked') return { status: 'waiting' };
      if (armMr.state !== 'opened')
        throw refuse(
          options.repo.id,
          'not_open',
          'MR was closed without merging.',
          'Inspect the MR; do not report it as merged.',
          armCurrent,
        );
      if (armMr.draft)
        throw refuse(
          options.repo.id,
          'draft_status',
          'MR is still a draft.',
          'Complete reviews and mark ready before arming.',
          armCurrent,
        );
      const armStatus = mergeReasons.safeParse(armMr.detailed_merge_status);
      if (armStatus.success) {
        if (['checking', 'preparing', 'unchecked'].includes(armStatus.data))
          return { status: 'waiting' };
        throw refuse(
          options.repo.id,
          armStatus.data,
          `GitLab reports ${armStatus.data}.`,
          'Repair the branch/CI in the bounded merge loop.',
          armCurrent,
        );
      }
      if (armMr.merge_when_pipeline_succeeds === undefined)
        throw refuse(
          options.repo.id,
          'permission_unknown',
          'Auto-merge state is not observable.',
          'Verify the GitLab version and auto-merge readback with a maintainer.',
          armCurrent,
        );
      const armKey = createHash('sha256')
        .update(
          `${http.root}\0${options.repo.project}\0${options.token}\0${pr.id}\0${pr.headSha}`,
        )
        .digest('hex');
      if (armMr.merge_when_pipeline_succeeds === true && armedHeads.has(armKey))
        return { status: 'waiting' };
      // The merge-named endpoint is exclusively an auto_merge request, never immediate merge.
      if (support.trains) {
        const response = await http.request(
          'POST',
          `${root}/merge_trains/merge_requests/${pr.number}`,
          trainSchema,
          { sha: pr.headSha, auto_merge: true },
        );
        if (
          response.merge_request.id !== Number(armCurrent.id) ||
          response.merge_request.iid !== armCurrent.number ||
          response.target_branch !== armCurrent.baseBranch
        )
          throw refuse(
            options.repo.id,
            'invalid_response',
            'Merge-train enrollment returned a different MR.',
            'Inspect the merge-train and MR identities before retrying.',
            armCurrent,
          );
      } else {
        const response = await http.request(
          'PUT',
          `${root}/merge_requests/${pr.number}/merge`,
          mrSchema,
          { sha: pr.headSha, auto_merge: true },
        );
        await checkMutationMr(response, armCurrent);
      }
      const oldestArm = armedHeads.values().next().value;
      if (armedHeads.size >= 1024 && oldestArm !== undefined)
        armedHeads.delete(oldestArm);
      armedHeads.add(armKey);
      return { status: 'waiting' };
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
      const pipeline = await currentPipeline(pr);
      if (!pipeline) return { status: 'waiting' };
      const jobs = await http.list(
        `${root}/pipelines/${pipeline.id}/jobs?include_retried=false`,
        jobSchema,
      );
      const failedJobs: FailedJob[] = [];
      for (const job of jobs.filter(
        (job) =>
          !job.allow_failure && ['failed', 'canceled'].includes(job.status),
      ))
        failedJobs.push({
          id: String(job.id),
          name: job.name,
          failedSteps: [],
          logTail: await http.logTail(
            `${root}/jobs/${job.id}/trace`,
            input.logTailLines,
          ),
        });
      if (
        !failedJobs.length &&
        ['failed', 'canceled'].includes(pipeline.status)
      )
        failedJobs.push({
          id: String(pipeline.id),
          name: `Pipeline ${pipeline.id} (${pipeline.status})`,
          failedSteps: [],
          logTail: '',
        });
      checkHead(pr, handle(await read(pr)));
      if (failedJobs.length)
        return {
          status: 'done',
          result: { status: 'failed', headSha: pr.headSha, failedJobs },
        };
      if (
        pipeline.status !== 'success' ||
        jobs.some(
          (job) =>
            !job.allow_failure && !['success', 'skipped'].includes(job.status),
        )
      )
        return { status: 'waiting' };
      return {
        status: 'done',
        result: { status: 'passed', headSha: pr.headSha, failedJobs: [] },
      };
    },
    async retryFailedJobs(pr: Pr): Promise<void> {
      const pipeline = await currentPipeline(pr);
      if (!pipeline)
        throw refuse(
          options.repo.id,
          'ci_still_running',
          'No current pipeline exists to retry.',
          'Wait for CI to create a pipeline.',
          pr,
        );
      if (pipeline.ref.endsWith('/train'))
        throw refuse(
          options.repo.id,
          'train_pipeline_dropped',
          'Merge-train pipelines cannot be retried.',
          'Re-add the MR in the bounded merge loop to create a new train pipeline.',
          pr,
        );
      const jobs = await http.list(
        `${root}/pipelines/${pipeline.id}/jobs?include_retried=false`,
        jobSchema,
      );
      for (const job of jobs.filter(
        (job) =>
          !job.allow_failure && ['failed', 'canceled'].includes(job.status),
      )) {
        const current = handle(await read(pr));
        if (current.state !== 'open')
          throw refuse(
            options.repo.id,
            'not_open',
            'MR is not open.',
            'Inspect the MR before retrying failed jobs.',
            current,
          );
        checkHead(pr, current);
        await http.request(
          'POST',
          `${root}/jobs/${job.id}/retry`,
          z.object({ id: z.number() }),
        );
      }
    },
    async reviewThreads(pr: Pr): Promise<ReviewThread[]> {
      const current = handle(await read(pr));
      const discussions = await http.list(
        `${root}/merge_requests/${pr.number}/discussions`,
        discussionSchema,
      );
      return discussions.flatMap((discussion) => {
        const notes = discussion.notes.filter((note) => !note.system);
        if (!notes.length) return [];
        const position = notes.find((note) => note.position)?.position;
        const path = position?.new_path ?? position?.old_path;
        const line = position?.new_line ?? position?.old_line;
        return [
          {
            pr: current,
            id: discussion.id,
            ...(path === undefined ? {} : { path }),
            ...(line == null ? {} : { line }),
            body: notes.map((note) => note.body).join('\n\n'),
            resolved:
              notes.some((note) => note.resolvable) &&
              notes
                .filter((note) => note.resolvable)
                .every((note) => note.resolved),
          },
        ];
      });
    },
    async replyToThread(
      thread: ReviewThread,
      body: string,
      runId: string,
    ): Promise<void> {
      const current = handle(await read(thread.pr));
      const path = `${root}/merge_requests/${current.number}/discussions/${encodeURIComponent(thread.id)}`;
      const discussion = await http.request('GET', path, discussionSchema);
      if (discussion.id !== thread.id)
        throw refuse(
          options.repo.id,
          'invalid_response',
          'Discussion identity changed.',
          'Inspect the MR discussion.',
        );
      const actual = (await this.reviewThreads(current)).find(
        (candidate) => candidate.id === thread.id,
      );
      if (!actual)
        throw refuse(
          options.repo.id,
          'not_open',
          'Discussion does not belong to the current MR.',
          'Re-read discussions from this MR before replying.',
          current,
        );
      const intent = replyIntent(
        actual,
        body,
        runId,
        discussion.notes.map((note) => note.body),
        options.token,
      );
      if (!intent.exists)
        await coalesceReply(
          replyScope(http.root, options.repo.project, actual.id, options.token),
          intent.body,
          async () => {
            try {
              await http.request(
                'POST',
                `${path}/notes`,
                z.object({ id: z.number() }),
                { body: intent.body },
              );
            } catch (error) {
              if (!(
                error instanceof ScmError &&
                [409, 422].includes(error.status ?? 0)
              ))
                throw error;
              const recovered = await http.request(
                'GET',
                path,
                discussionSchema,
              );
              if (
                !replyIntent(
                  actual,
                  body,
                  runId,
                  recovered.notes.map((note) => note.body),
                  options.token,
                ).exists
              )
                throw error;
            }
          },
        );
      // GitLab offers no CAS resolution bound to this exact discussion
      // revision. A human or platform automation must resolve it safely.
    },
  };
}
