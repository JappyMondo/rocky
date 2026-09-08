/** Persisted Run-header display summary. Not sufficient to address platform operations. */
export interface Pr {
  number: number;
  url: string;
  headSha: string;
}

/** Platform-only, JSON-safe handle. Required identity is never inferred from a URL. */
export interface ScmPr extends Pr {
  repo: string;
  id: string;
  sourceBranch: string;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}

export interface FailedJob {
  id: string;
  name: string;
  failedSteps: string[];
  logTail: string;
}

export interface CiResult {
  status: 'passed' | 'failed';
  headSha: string;
  failedJobs: FailedJob[];
}

export interface ReviewThread {
  pr: ScmPr;
  id: string;
  /** General MR discussions have no platform anchor; content must locate one. */
  path?: string;
  line?: number;
  body: string;
  resolved: boolean;
}

/** GitLab detailed_merge_status vocabulary, plus explicit transport/permission cases. */
export type ScmRefusalReason =
  | 'approvals_syncing'
  | 'blocked_status'
  | 'checking'
  | 'ci_must_pass'
  | 'ci_still_running'
  | 'commits_status'
  | 'conflict'
  | 'discussions_not_resolved'
  | 'draft_status'
  | 'external_status_checks'
  | 'jira_association_missing'
  | 'merge_request_blocked'
  | 'merge_time'
  | 'need_rebase'
  | 'not_approved'
  | 'not_open'
  | 'requested_changes'
  | 'preparing'
  | 'status_checks_must_pass'
  | 'unchecked'
  | 'security_policy_violations'
  | 'security_policy_pipeline_check'
  | 'title_regex'
  | 'permission_denied'
  | 'permission_unknown'
  | 'head_changed'
  | 'source_missing'
  | 'unsupported'
  | 'train_pipeline_dropped'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response';

export interface ScmRefusal {
  refused: true;
  repo: string;
  reason: ScmRefusalReason;
  message: string;
  fix: string;
  pr?: ScmPr;
}

export interface OpenPrOptions {
  /** Member identity from the frozen Run; defaults to the lead. */
  repo?: string;
  title: string;
  body: string;
  /** Defaults to true. Onboarding explicitly opens a non-draft seed PR. */
  draft?: boolean;
}

/**
 * An approval minted by this Boot's `ctx.checkpoint`.  The symbol is declared
 * only in the type system: SDK consumers receive no runtime constructor or
 * brand to forge.
 */
declare const approvedCheckpointBrand: unique symbol;
export interface ApprovedCheckpoint {
  decision: 'approve';
  readonly [approvedCheckpointBrand]: true;
}

export type UpdateBranchResult =
  | { status: 'updated' | 'clean' | 'conflict'; pr: ScmPr }
  | { status: 'local_base_merge_required'; pr: ScmPr }
  | ScmRefusal;

export type MergeResult = { status: 'merged'; pr: ScmPr } | ScmRefusal;

export interface ScmOps {
  openPr(options: OpenPrOptions): Promise<ScmPr | ScmRefusal>;
  markDraft(
    pr: ScmPr,
    draft: boolean,
    options?: { body?: string },
  ): Promise<ScmPr | ScmRefusal>;
  /** One parking Step, no wall-clock timeout. Logs are fetched only for failures. */
  waitForCi(
    pr: ScmPr,
    options: { logTailLines: number },
  ): Promise<CiResult | ScmRefusal>;
  retryFailedJobs(pr: ScmPr): Promise<void | ScmRefusal>;
  /** Local fallback is content's ctx.exec work, never adapter-side git. */
  updateBranch(pr: ScmPr): Promise<UpdateBranchResult>;
  /** Call after Checkpoint approval and every fix push. Armed is not merged. */
  armAutoMerge(pr: ScmPr, approval: ApprovedCheckpoint): Promise<MergeResult>;
  reviewThreads(pr: ScmPr): Promise<ReviewThread[] | ScmRefusal>;
  /** Find-or-create by manual Run + thread + immutable reply intent. */
  replyToThread(thread: ReviewThread, body: string): Promise<void | ScmRefusal>;
}
