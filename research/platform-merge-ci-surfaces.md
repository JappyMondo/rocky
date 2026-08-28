# Platform Merge and CI-Status Surfaces: GitHub vs GitLab

Date: 2026-08-28
Ticket: [NG-569](https://linear.app/digimondo/issue/NG-569)
Sources: official docs only (docs.github.com, docs.gitlab.com). GitHub GraphQL shapes additionally verified by live schema introspection (`gh api graphql` against `api.github.com`, 2026-08-28); GitLab enum lists cross-checked against the GraphQL reference, which is generated from the same schema the REST docs describe.

**TL;DR** — Both platforms can do everything the map needs, but only through *different* primitives, and the shape of the cheapest design is dictated by one fact: **a per-developer instance with no admin rights cannot create webhooks on either platform** (GitHub: "You must be a repository owner or have admin access in the repository to create webhooks"; GitLab: "You must be an administrator or have the Maintainer or Owner role"). So the CI watch loop is **polling on both**, and the tunnel is not required for the merge/CI map at all. Polling is cheap: GitHub gives 5,000 req/hour *and* does not charge `304 Not Modified` against the primary limit, so a conditional-request poller is nearly free; GitLab gives 2,000 req/**minute** per user, which is so generous that no conditional-request mechanism is needed (and none is documented). For merging, the right primitive is **not** the plain merge call on either side: it is **"ask the platform to merge when it is ready"** — GitHub `enablePullRequestAutoMerge` (GraphQL), GitLab `PUT .../merge` with `auto_merge=true`. Both of those *automatically* route into the platform's train/queue where one is configured (GitLab explicitly since 19.1; GitHub implicitly, evidenced by the merge-queue caveats on the auto-merge mutation inputs), which means the merge Agent needs **one code path per platform, not one per queue configuration**. The two real parity gaps are: **GitHub can server-side rebase, GitLab's rebase is a force-push to the source branch that a Developer may be forbidden to do**; and **GitLab's draft flag is a title-string convention with no API field**. The two real tier traps: GitLab **merge trains and blocking "request changes" are Premium+**, and GitLab **approval rules are Premium+** (plain approve/unapprove is Free).

---

## Matrix: works / works differently / not possible

| Capability | GitHub | GitLab | Verdict |
|---|---|---|---|
| Learn a pipeline finished, **no admin rights** | Poll `commits/{ref}/check-runs` + `commits/{ref}/status` (+ `actions/runs`) | Poll `projects/:id/pipelines` / MR `head_pipeline` | **Works** both |
| Webhook for pipeline completion | `workflow_run`/`check_suite`/`check_run`/`status` — but creating the hook needs repo admin | `pipeline_events`/`job_events` — but creating the hook needs Maintainer+ | **Not possible** for a non-admin per-developer daemon on either |
| Polling budget | 5,000 req/hour; `304` responses **free** | 2,000 req/**minute** per user | **Works differently** (GitHub tighter but has conditional-request discount) |
| Conditional requests / ETag discount | Documented and rate-limit-exempt on `304` | **Not documented** | **Works differently** |
| Fetch failing job log | `GET actions/jobs/{job_id}/logs` → 302 to plain-text URL, link valid 1 min | `GET projects/:id/jobs/:job_id/trace` → serves log file | **Works** both |
| Log size cap / range fetch | No documented cap; no range param; retained 90 days by default | No documented cap; no documented `limit`/range param | **Works differently** (both force client-side truncation) |
| Filter to only failed jobs | `?status=failure` on runs; per-job `conclusion` | `?scope=failed` on pipeline jobs | **Works** both |
| Plain merge via API | `PUT /pulls/{n}/merge` (`merge`/`squash`/`rebase`, `sha` guard) | `PUT .../merge` (`squash`, `sha` guard) | **Works** both |
| "Merge when green" (no local push) | GraphQL `enablePullRequestAutoMerge` | `PUT .../merge` with `auto_merge=true` | **Works** both |
| Enqueue into merge queue / train as a token client | GraphQL `enqueuePullRequest` (also reachable via auto-merge) | `POST /merge_trains/merge_requests/:iid`, or `auto_merge=true` auto-routes (19.1+) | **Works** both |
| Observe queue/train position after enqueue | `mergeQueueEntry { position, state, estimatedTimeToMerge }` | Merge train entry `status` (`idle`/`fresh`/`stale`/`merging`/`merged`/`skip_merged`) | **Works differently** |
| Queue/train tier | Merge queue: repo settings / rulesets | Merge trains: **Premium, Ultimate** | **Works differently** (GitLab paid) |
| "Is this mergeable right now" | `mergeable` (bool\|**null** = still computing) + `mergeable_state`; GraphQL `MergeStateStatus` (7 values) | `detailed_merge_status` (24 values), computed async on GET | **Works differently** (GitLab far more expressive) |
| Distinguish "not yet" from "never" | Only via 7-value `MergeStateStatus` + reading required rules separately | Directly from `detailed_merge_status` | **Works differently** (GitLab strictly better) |
| Read required checks **without admin** | `GET /repos/{o}/{r}/rules/branches/{branch}` — **Metadata: read** only | `GET /projects/:id/protected_branches` — role requirement not documented | **Works differently** (GitHub has a clean non-admin path) |
| Read classic branch protection | `GET /branches/{b}/protection` — **Administration: read** (admin) | n/a | **Not possible** for a normal developer on GitHub |
| Server-side update-branch (merge base in) | `PUT /pulls/{n}/update-branch` (202) | No merge-base-in equivalent | **Works differently** |
| Server-side **rebase** | GraphQL `updatePullRequestBranch(updateMethod: REBASE)` | `PUT .../rebase` (202, poll `rebase_in_progress`) | **Works** both |
| Rebase permission reality | Needs Pull requests: write on the head repo | 403 if you can't push to the source branch, incl. "protected from force push" | **Works differently** (GitLab fails more often) |
| Open as draft | `draft: true` on `POST /pulls` | `Draft:` **title prefix** — no API boolean | **Works differently** |
| Flip draft → ready | GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft` (**not in REST**) | `PUT .../merge_requests/:iid` with title prefix removed, or `/ready` quick action | **Works differently** (both need a non-obvious path) |
| Read "changes requested" | `GET /pulls/{n}/reviews` state, GraphQL `reviewDecision` | `GET .../reviewers` state; `detailed_merge_status: requested_changes`; GraphQL `MergeRequestReviewState` | **Works** both |
| "Changes requested" actually blocks merge | Via branch protection required reviews | **Premium, Ultimate** only (GA 17.3) | **Works differently** (GitLab Free: advisory only) |
| Approval counts / rules readable | `GET /pulls/{n}/reviews` + required-reviews rule | `GET .../approvals` (all tiers); `approval_state` and rules **Premium+** | **Works differently** |
| Merge permission a developer normally has | Write role suffices unless rules restrict | Developer may be unable to merge at all depending on **Allowed to merge** | **Works differently** (GitLab blocks more often) |
| Token permission to merge | Fine-grained PAT **Contents: write** (not Pull requests) | `api` scope + a role in **Allowed to merge** | **Works differently** |

---

## 1. Watching CI

### 1.1 Webhooks are off the table for a non-admin per-developer daemon

This is the single load-bearing finding, and it is symmetrical.

**GitHub:** "You can create a webhook to subscribe to events that occur in a specific repository. You must be a repository owner or have admin access in the repository to create webhooks in that repository." ([Creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)). Organization-level hooks are worse: "You must be an organization owner to create webhooks in that organization." The fine-grained-PAT permission for `POST /repos/{owner}/{repo}/hooks` is the repository **"Webhooks"** permission ([Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)) — and a fine-grained PAT can never grant more than the user already has, so a developer without admin cannot obtain it.

**GitLab:** "You must be an administrator or have the Maintainer or Owner role for the project." ([Project webhooks API](https://docs.gitlab.com/api/project_webhooks/)). The relevant flags on `POST /projects/:id/hooks` are `pipeline_events` ("Trigger project webhook on pipeline events") and `job_events` ("Trigger project webhook on job events") (same page).

**Consequence for the map:** the CI watch-and-fix loop must be **poll-first**. The cloudflared tunnel is *not* a prerequisite for the merge/CI capability — it only becomes relevant if a repo admin voluntarily configures a hook pointing at a Rocky instance, which is an unreliable thing to build on when the tunnel is ephemeral (a new hostname per daemon start means any hook URL a maintainer created goes stale). **Treat webhooks as an optional accelerator on top of a polling baseline, never as the mechanism.**

If a hook *is* available, the useful events are:
- GitHub: `workflow_run` (`completed`, `in_progress`, `requested`), `workflow_job` (`completed`, `in_progress`, `queued`, `waiting`), `check_run` (`completed`, `created`, `requested_action`, `rerequested`), `check_suite` (`completed`, `requested`, `rerequested`), `status`, and `merge_group` (`checks_requested`, `destroyed`) ([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- GitLab: "Pipeline events are triggered when the status of a pipeline changes" (header `X-Gitlab-Event: Pipeline Hook`, payload `object_kind: "pipeline"`, `object_attributes.status`, and a `builds[]` array with per-job `id`/`stage`/`name`/`status`); "Job events are triggered when the status of a job changes. Trigger jobs are excluded." ([Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)).

### 1.2 Polling: what to poll

**GitHub.** CI on GitHub is not only Actions — third-party CI reports as check runs or commit statuses, and required checks "can be checks or commit statuses" ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). A watcher that only polls `actions/runs` will miss third-party CI. Poll instead:
- `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` with `filter=latest` (default; "latest returns the most recent check runs") and optional `status` / `check_name` / `app_id`; each check run carries `status` (`queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`) and `conclusion` (`success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, `null`) ([Checks / Runs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28)).
- `GET /repos/{owner}/{repo}/commits/{ref}/status` for the combined legacy status ([Commit statuses](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28)); permission is **Commit statuses: read**.
- `GET /repos/{owner}/{repo}/actions/runs` when Actions-specific detail is needed, filtered by `head_sha` ("Only returns workflow runs that are associated with the specified head_sha"), `branch`, `status`, `event`, and `exclude_pull_requests` ([Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28)). Permission: **Actions: read**.

**GitLab.** Pipelines are the single surface:
- `GET /projects/:id/pipelines` filtered by `sha`, `ref`, `status`, `source`, `updated_after`, ordered by `updated_at` ([Pipelines API](https://docs.gitlab.com/api/pipelines/)). Statuses: `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`, `running`, `success`, `failed`, `canceling`, `canceled`, `skipped`, `manual`, `scheduled`.
- Cheaper still: the MR object itself carries `head_pipeline`, and `detailed_merge_status` already distinguishes `ci_still_running` from `ci_must_pass` (see §3) — so **one MR GET can serve as both the CI poll and the mergeability poll on GitLab**. That collapses two loops into one.

### 1.3 Polling cost against rate limits

**GitHub.** Primary limit for a user PAT / OAuth user-to-server token is **"5,000 requests per hour"**; unauthenticated is 60/hour ([Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)). Secondary limits that matter to a poller: "No more than 100 concurrent requests are allowed" and "No more than 900 points per minute are allowed for REST API endpoints". Headers `x-ratelimit-limit` / `-remaining` / `-used` / `-reset` / `-resource` let the daemon self-throttle.

The decisive fact is the conditional-request discount: "Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header. This makes conditional requests especially useful when you poll an endpoint, because each `304 Not Modified` response is fast and does not use your rate limit." GitHub also asks pollers to "Poll only as often as you need to, on a fixed schedule. If a response includes an `x-poll-interval` header, wait at least that many seconds before you poll the same endpoint again", and to "Request only the data that you need, and keep responses stable, so that more of your polls return `304 Not Modified`" ([Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)).

Budget: 5,000/hour is ~1.4 req/s. A 10-second poll of two endpoints per active PR costs 720 req/hour per PR *if every response changes*; with ETags most polls return `304` and cost nothing, so the practical ceiling is set by *change* events, not by poll frequency. Note the same page's warning about repeated `404`s: GitHub "returns a `404 Not Found` response instead of a `403 Forbidden` response for some private resources when your credentials do not grant access", and hammering a 404 "wastes your rate limit and can trigger a secondary rate limit" — relevant when a developer's token silently lacks Actions read.

**GitLab.** "Authenticated API traffic for a user" is **2,000 requests each minute** on GitLab.com; unauthenticated traffic from an IP is 500/minute ([GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/#rate-limits-on-gitlabcom)). That is 120,000/hour — 24× GitHub's budget, so aggressive polling is simply not a problem. Rate-limit state is returned in `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-ResetTime` and `Retry-After` headers, with the caveat that "Response headers only show the most restrictive `Rack::Attack` rate limit status" and application-level limits "are not included in response headers" ([User and IP rate limits](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/#response-headers)). Pagination defaults: `per_page` default 20, max 100 ([REST API](https://docs.gitlab.com/api/rest/)).

**No documented ETag/conditional-GET discount exists for the GitLab REST API** — the REST reference documents `Link`, `x-next-page`, `x-page`, `x-per-page`, `x-total`, `x-total-pages`, `X-NEXT-CURSOR`, `X-PREV-CURSOR` and nothing about `If-None-Match` ([REST API](https://docs.gitlab.com/api/rest/)). Do not design a GitLab poller that depends on `304`s; design it to depend on the very large request budget instead.

---

## 2. Reading failures

### 2.1 GitHub

Two-step: list jobs, then pull logs for the failed ones.

- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` with `filter=latest` (default) or `all` ("returns all jobs including from old executions"). Each job carries `status`, `conclusion`, and a `steps[]` array where each step has its own `status`, `conclusion`, `name`, `number` and timings ([Workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28)). **The `steps[]` array alone often identifies the failure without fetching any log** — a cheap first move for the fixer Agent.
- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` — "Gets a redirect URL to download a plain text file of logs for a workflow job." It returns **302** with the URL in the `Location` header, and "This link expires after 1 minute." "Anyone with read access to the repository can use this endpoint"; classic PATs need `repo` for private repos, fine-grained needs **Actions: read** (same page + [fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)).
- Whole-run logs are available as a zip at `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` (and per-attempt at `.../attempts/{attempt_number}/logs`), both **Actions: read**.
- Retention: "By default, the artifacts and log files generated by workflows are retained for 90 days before they are automatically deleted", configurable 1–90 days for public and 1–400 for private repositories ([Configuring the retention period](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-repository)). Not a constraint for a live fix loop; it *is* a constraint on retrospective analysis.

**No documented size cap and no range/tail parameter.** The two-call shape (302 then a signed GET) also means the log body does not flow through the rate-limited API host, so log volume does not eat the 5,000/hour budget — only the 302 does.

### 2.2 GitLab

- `GET /projects/:id/pipelines/:pipeline_id/jobs` with `scope` (accepts a string **or array of strings** of job statuses) and `include_retried` ("Include retried jobs in the response. Defaults to `false`") ([Jobs API](https://docs.gitlab.com/api/jobs/)). Job statuses: `canceled`, `canceling`, `created`, `failed`, `manual`, `pending`, `preparing`, `running`, `scheduled`, `skipped`, `success`, `waiting_for_callback`, `waiting_for_resource`. `scope=failed` is the direct "give me only the broken jobs" query.
- `GET /projects/:id/jobs/:job_id/trace` — "Serves the log file", 404 when "Job not found or no log file" (same page). It is a direct body, not a redirect. **The docs specify no content type, no size limit, no truncation behaviour, and no `limit`/range parameter** — so a naive fixer that hands the whole trace to a model is unbounded by anything the API promises.

### 2.3 How much can a fixer Agent realistically be handed?

Neither platform offers server-side tailing, grepping, or truncation, and neither documents a size bound. The realistic budget is set by the model context, not the API, so **truncation is Rocky's problem and must be a first-class component**, not an afterthought. Design implications that follow directly from the doc shapes above:

1. **Prefer structured failure metadata over logs.** GitHub's `steps[]` (per-step `conclusion`) and GitLab's `scope=failed` job list name the failing unit for free. Fetch a log only for jobs already known to have failed.
2. **Tail, don't head.** Both endpoints return whole files with no range support; the daemon must stream and keep a bounded tail window (plus any earlier lines matching failure patterns).
3. **GitHub's 1-minute signed URL means the download must happen immediately** after the 302 — do not queue the URL for a later worker.
4. GitLab's `builds[]` array inside the pipeline webhook payload (if a hook happens to exist) gives per-job status without any extra call.

---

## 3. Mergeability: "not yet" vs "never"

### 3.1 GitHub: async, and thin

`GET /repos/{owner}/{repo}/pulls/{pull_number}` returns `merged` (boolean), `mergeable` (**boolean or null**), `rebaseable` (boolean or null) and `mergeable_state` (string). The async contract: **"If the value is null, then GitHub has started a background job to compute the mergeability. After giving the job time to complete, resubmit the request."** ([Pulls API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28)). So the *first* read after any head/base movement is expected to be `null`; a merge Agent must treat `null` as "ask again", never as "not mergeable".

The REST reference does **not** enumerate `mergeable_state`. The documented enumeration lives in GraphQL as `MergeStateStatus` ([GraphQL reference: enums](https://docs.github.com/en/graphql/reference/enums#mergestatestatus)), verified by introspection:

| Value | Doc description | "not yet" or "never"? |
|---|---|---|
| `CLEAN` | "Mergeable and passing commit status." | ready |
| `UNSTABLE` | "Mergeable with non-passing commit status." | mergeable, but CI red — **not yet** (or never, if the failing check is required) |
| `HAS_HOOKS` | "Mergeable with passing commit status and pre-receive hooks." | ready |
| `BEHIND` | "The head ref is out of date." | **not yet** → fixable with update-branch (§5) |
| `BLOCKED` | "The merge is blocked." | ambiguous — needs the rules to interpret |
| `DIRTY` | "The merge commit cannot be cleanly created." | **conflict** → needs rebase/manual resolution |
| `UNKNOWN` | "The state cannot currently be determined." | **not yet** → poll again |

`BLOCKED` is the problem: it is one bucket covering missing approvals, failing required checks, unresolved conversations and rules the token holder cannot satisfy. **GitHub does not tell you *why* it is blocked from the PR object.** To disambiguate you must read the branch's rules separately (§7.1) and diff them against the observed review/check state. GraphQL softens this a little with viewer-scoped booleans, verified by introspection: `viewerCanEnableAutoMerge`, `viewerCanDisableAutoMerge`, `viewerCanUpdateBranch` ("Whether or not the viewer can update the head ref of this PR, by merging or rebasing the base ref"), `viewerCanMergeAsAdmin` ("Indicates whether the viewer can bypass branch protections and merge the pull request immediately"), `isInMergeQueue`, `isMergeQueueEnabled` ([GraphQL PullRequest object](https://docs.github.com/en/graphql/reference/objects#pullrequest)). `viewerCanEnableAutoMerge == false && viewerCanMergeAsAdmin == false` on a `BLOCKED` PR is the closest available signal for "never, by this token".

Conflicts specifically: `mergeable: false` with `mergeable_state: dirty`. Out-of-date base: `BEHIND` (only reported as blocking when required checks are "strict", §7.1).

### 3.2 GitLab: synchronous-ish, and much richer

Two documented mechanics:

1. **Async compute, but self-triggering.** "The mergeability (`merge_status`) of each merge request is checked asynchronously when a request is made to this endpoint. Poll this API endpoint to get the updated status." ([Merge requests API — single MR response notes](https://docs.gitlab.com/api/merge_requests/#single-merge-request-response-notes)). Same "poll again" contract as GitHub, but the GET itself kicks the check.
2. **List endpoints do not recheck.** "Listing merge requests might not proactively update `merge_status` (which also affects the `has_conflicts`), as this can be an expensive operation. If you need the value of these fields from this endpoint, set the `with_merge_status_recheck` parameter to `true` in the query." ([Merge requests list response notes](https://docs.gitlab.com/api/merge_requests/#merge-requests-list-response-notes)). A merge Agent that reads mergeability off a list call without this flag will act on stale data.

`merge_status` itself is **"[Deprecated] in GitLab 15.6"** in favour of `detailed_merge_status`; the legacy values are `unchecked`, `checking`, `can_be_merged`, `cannot_be_merged`, `cannot_be_merged_recheck`. `has_conflicts` is "Dependent on the `merge_status` property. Returns `false` unless `merge_status` is `cannot_be_merged`" — i.e. **`has_conflicts: false` is not evidence of no conflicts**, only that the status isn't `cannot_be_merged` yet.

`detailed_merge_status` is the field to build on. Full documented list ([Merge status](https://docs.gitlab.com/api/merge_requests/#merge-status)), classified for the merge Agent:

| Value | Doc description | Class |
|---|---|---|
| `mergeable` | "The branch can merge cleanly into the target branch." | **go** |
| `checking` | "Git is testing if a valid merge is possible." | not yet — poll |
| `unchecked` | "Git has not yet tested if a valid merge is possible." | not yet — poll |
| `preparing` | "Merge request diff is being created." | not yet — poll |
| `approvals_syncing` | "The merge request's approvals are syncing." | not yet — poll |
| `ci_still_running` | "A CI/CD pipeline is still running." | **not yet — this is the CI watch signal** |
| `ci_must_pass` | "A CI/CD pipeline must succeed before merge." | not yet → fix loop |
| `need_rebase` | "The merge request must be rebased." | not yet → §5 rebase |
| `conflict` | "Conflicts exist between the source and target branches." | needs code work |
| `discussions_not_resolved` | "All discussions must be resolved before merge." | needs action |
| `draft_status` | "Can't merge because the merge request is a draft." | Rocky's own doing → §6 |
| `not_approved` | "Approval is required before merge." | **human gate** |
| `requested_changes` | "The merge request has reviewers who have requested changes." | **human gate — wake the fixer loop** |
| `merge_request_blocked` | "Blocked by another merge request." | not yet, external |
| `merge_time` | "May not be merged until after the specified time." | not yet, timed |
| `commits_status` | "Source branch should exist, and contain commits." | broken |
| `not_open` | "The merge request must be open before merge." | **never** |
| `status_checks_must_pass` | "All status checks must pass before merge." | external (Ultimate feature) |
| `jira_association_missing` | title or description must reference a Jira issue | **never, without config knowledge** |
| `title_regex` | "Checks whether the title matches the expected regex, if configured in project settings." | **never, without config knowledge** |
| `security_policy_pipeline_check` / `security_policy_violations` | security policies must be satisfied | likely **never** for Rocky |
| `locked_paths` / `locked_lfs_files` | paths/LFS files locked by other users must be unlocked | **never** without a human |

GraphQL exposes the same set as the `DetailedMergeStatus` enum with parallel descriptions, plus `BLOCKED_STATUS` ("Merge request dependencies must be merged") and `EXTERNAL_STATUS_CHECKS` ([GitLab GraphQL reference](https://docs.gitlab.com/api/graphql/reference/#detailedmergestatus)).

**This is the sharpest divergence in the whole investigation, and it favours GitLab.** GitLab hands you the blocking reason; GitHub gives you `BLOCKED` and expects you to reconstruct why. Any shared internal model should be shaped like `detailed_merge_status` and *derived* on GitHub, not the reverse.

---

## 4. Merging through the platform's own controls

### 4.1 GitHub

**Plain merge.** `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` with `commit_title`, `commit_message`, `sha` ("SHA that pull request head must match to allow merge") and `merge_method` (`merge`, `squash`, `rebase`). Response codes: 200 "if merge was successful", **405 "Method Not Allowed if merge cannot be performed"**, **409 "Conflict if sha was provided and pull request head did not match"**, 403, 404, 422 ([Pulls API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)). Always send `sha` — it converts a race into a 409 instead of merging code Rocky never saw. Fine-grained permission is **Contents: write**, *not* Pull requests: write ([fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)); that page also lists `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge` (the "is merged?" check) under Pull requests: read.

**Auto-merge is the primitive the merge Agent should default to.** "Auto-merge merges a pull request automatically after all required reviews and status checks pass." Prerequisites: "Before you use auto-merge, it must be enabled for the repository" (a repo setting) and branch protection must exist, such as "Require pull request reviews before merging" or "Require status checks to pass before merging". "People with write permissions to a repository can enable auto-merge for a pull request." It is "disabled if someone without write permissions pushes new changes to the head branch or switches the base branch" ([Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)).

There is **no REST endpoint for auto-merge**; it is GraphQL `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge` ([GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations#enablepullrequestautomerge)). Introspected input: `pullRequestId`, `commitHeadline`, `commitBody`, `mergeMethod`, `authorEmail`, `expectedHeadOid`. Three of those inputs carry the note *"NOTE: when merging with a merge queue any input value for commit headline / commit message / merge method is ignored"* — which is the documentation's own confirmation that **auto-merge is the path that feeds the merge queue**. Use `expectedHeadOid` as the same race guard `sha` provides on REST.

**Merge queue.** "Once a pull request has passed all required branch protection checks, a user with write access to the repository can add the pull request to the queue." ([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)). So *yes* — a token-holding client with write access can enqueue rather than merge, and needs no admin rights to do so.

Direct enqueue is GraphQL `enqueuePullRequest` ([GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations#enqueuepullrequest)); introspected input `pullRequestId`, `jump` ("Add the pull request to the front of the queue"), `expectedHeadOid`, returning a `MergeQueueEntry`. `dequeuePullRequest` removes it.

What it observes afterwards — `MergeQueueEntry` fields (introspected; [GraphQL objects](https://docs.github.com/en/graphql/reference/objects#mergequeueentry)): `position` ("The position of this entry in the queue"), `state`, `estimatedTimeToMerge` ("The estimated time in seconds until this entry will be merged"), `enqueuedAt`, `enqueuer`, `baseCommit`, `headCommit`, `jump`, `solo` ("Does this pull request need to be deployed on its own"). `MergeQueueEntryState` ([enums](https://docs.github.com/en/graphql/reference/enums#mergequeueentrystate)): `QUEUED`, `AWAITING_CHECKS` ("The entry is currently waiting for checks to pass"), `MERGEABLE`, `UNMERGEABLE`, `LOCKED`. On the PR: `isInMergeQueue`, `isMergeQueueEnabled`, `mergeQueueEntry`. Webhook-side, `pull_request` has `enqueued` and `dequeued` actions, and `merge_group` has `checks_requested` / `destroyed`.

Two operational traps in the queue docs:
- **CI must opt in.** "You **must** use the `merge_group` event to trigger your GitHub Actions workflow when a pull request is added to a merge queue", and "A merge queue will wait for required checks to be reported before it can proceed with merging." Merge groups run on temporary branches prefixed `gh-readonly-queue/{base_branch}`. If the repo's CI doesn't handle `merge_group`, an enqueued PR stalls indefinitely — Rocky must time out rather than wait forever.
- **Failure ejects.** "When the GitHub API receives a failing status for `main/pr-1`, the merge queue automatically removes pull request #1 from the merge queue" and "The pull request timeline will display the reason why the pull request was removed from the queue." So after enqueueing, Rocky must treat `mergeQueueEntry` becoming `null` while unmerged as a *failure* signal — the PR ending up neither queued nor merged is the failure mode.

### 4.2 GitLab

**One endpoint does all three jobs.** `PUT /projects/:id/merge_requests/:merge_request_iid/merge` ([Merge a merge request](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request)):

| Attribute | Doc description |
|---|---|
| `auto_merge` | "If `true`, the merge request merges when checks pass." |
| `merge_when_pipeline_succeeds` | "[Deprecated] in GitLab 17.11. Use `auto_merge` instead." |
| `sha` | "If present, this SHA must match the HEAD of the source branch. Use to ensure that only reviewed commits are merged. Required if the [require a commit SHA on the merge requests API] setting is enabled for the group or instance." |
| `squash`, `should_remove_source_branch`, `merge_commit_message`, `squash_commit_message` | commit shaping |

Failure codes, verbatim: `400 SHA must be provided when merging`; `401 401 Unauthorized` — "This user does not have permission to accept this merge request"; **`405 405 Method Not Allowed` — "The merge request cannot merge."**; **`409 SHA does not match HEAD of source branch`**; `422 Branch cannot be merged` — "The merge request failed to merge."

The 405/409 pair mirrors GitHub's exactly, which means a shared client can normalise them: *405/405 = "not mergeable, re-read status"*, *409/409 = "head moved under us, re-read and retry"*.

**Merge trains are reached through the same call.** The endpoint's own history note: "Routing `auto_merge` requests to the merge train on projects with [merge trains] enabled [changed] in GitLab 19.1 with a feature flag named `fix_merge_api_train_bypass`... **The merge request is added to the merge train instead of merging directly.**" and "Feature flag `fix_merge_api_train_bypass` removed in GitLab 19.1." (same page). This is a genuinely important finding: **on GitLab ≥ 19.1, `auto_merge=true` is train-aware, so the merge Agent needs no train-specific branch.** On older instances the same call would have bypassed the train — so Rocky should record the instance version and, below 19.1, use the explicit train API.

Explicit train API ([Merge trains API](https://docs.gitlab.com/api/merge_trains/)): tier "Premium, Ultimate"; "You must have the Developer, Maintainer, or Owner role"; `POST /projects/:id/merge_trains/merge_requests/:merge_request_iid` with `auto_merge` ("If true, the merge request is added to the merge train when the checks pass"), `sha` ("If present, the SHA must match the `HEAD` of the source branch"), `squash`, and deprecated `when_pipeline_succeeds` ("Deprecated in GitLab 17.11. Use `auto_merge` instead"). Read back via `GET /projects/:id/merge_trains`, `GET /projects/:id/merge_trains/:target_branch`, `GET /projects/:id/merge_trains/merge_requests/:merge_request_iid`. Entry `status`: active `idle`, `fresh`, `stale`; complete `merging`, `merged`, `skip_merged`.

Train prerequisites and failure behaviour ([Merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)): tier "Premium, Ultimate"; "Your pipeline must be configured to use merge request pipelines"; "You must have merged results pipelines enabled". "Each merge train can run a maximum of 20 pipelines in parallel." On failure: "The merge request is not merged. GitLab removes that merge request from the merge train, and starts new pipelines for all the merge requests that were queued after it." Same watch-for-ejection requirement as GitHub's queue.

**Cancelling.** `POST /projects/:id/merge_requests/:merge_request_iid/cancel_merge_when_pipeline_succeeds` — "Cancels an active auto-merge for a merge request. If the merge request is on a merge train, this also removes it from the train." Returns `201` on "Success, or the merge request has already merged", `406 Can't cancel the automatic merge` when "The merge request is closed" ([Merge requests API](https://docs.gitlab.com/api/merge_requests/#cancel-merge-when-pipeline-succeeds)). The endpoint path still says `merge_when_pipeline_succeeds` even though the setter has been renamed to `auto_merge` — an easy implementation trap.

**What an MR needs before the API accepts a merge**, from the auto-merge doc ([Auto-merge](https://docs.gitlab.com/user/project/merge_requests/auto_merge/)): "All required approvals must be given. No other merge requests block this merge request. No merge conflicts exist. A CI/CD pipeline must complete successfully", plus resolved discussions, no Draft status, and passed external checks. Auto-merge self-cancels on new work: "If you add new commits to the merge request, GitLab cancels the request to ensure the new changes receive a review before merge", and also "If you add new commits to the target branch, and your project uses the **Merge commit with semi-linear history** or **Fast-forward merge** method without automatic rebase before merge turned on, GitLab cancels the request." **So on GitLab, Rocky pushing a fix commit silently cancels its own auto-merge** — the merge Agent must re-arm auto-merge after every fix iteration. (GitHub's auto-merge is only disabled when someone *without* write permissions pushes, so Rocky's own fix pushes do not disarm it — an asymmetry worth encoding.)

---

## 5. Rebase / update-branch: moving a stale PR forward without local pushes

Both platforms have a server-side action, but they are not the same action.

**GitHub** offers *both* directions:
- Merge base into head: `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` — "Updates the pull request branch with the latest upstream changes by merging HEAD from the base branch into the pull request branch." Optional `expected_head_sha` ("The expected SHA of the pull request's HEAD ref"), returns **202** ([Pulls API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#update-a-pull-request-branch)). Fine-grained permission: **Pull requests: write**; the doc adds "If making a request on behalf of a GitHub App you must also have permissions to write the contents of the head repository."
- **True rebase:** GraphQL `updatePullRequestBranch` with `updateMethod` of type `PullRequestBranchUpdateMethod` — introspected values `MERGE` ("Update branch via merge") and `REBASE` ("Update branch via rebase"), defaulting to `MERGE` ([GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations#updatepullrequestbranch)). Inputs `pullRequestId`, `expectedHeadOid`, `updateMethod`. **This is not available in REST** — the REST endpoint only merges.

Caution: updating the branch can cost an approval. "If the diff changes from this state (for example, because a contributor pushes new changes to the pull request branch or clicks **Update branch**, or because a related pull request is merged into the target branch), the approving review is dismissed as stale, and the pull request cannot be merged until someone approves the work again" — when "Dismiss stale pull request approvals" is on ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). So an over-eager update-branch loop can *destroy* the human approval the merge Agent is waiting for.

**GitLab** offers rebase only: `PUT /projects/:id/merge_requests/:merge_request_iid/rebase` — "Automatically rebase the `source_branch` of the merge request against its `target_branch`", with `skip_ci` ("Set to `true` to skip creating a CI pipeline") ([Rebase a merge request](https://docs.gitlab.com/api/merge_requests/#rebase-a-merge-request)). Status codes:

- `202` — "Successfully enqueued."
- `403 Cannot push to source branch` / `403 Source branch does not exist` / **`403 Source branch is protected from force push`** — all documented as "You don't have permission to push to the merge request's source branch."
- `409 Failed to enqueue the rebase operation` — "A long-lived transaction might have blocked your request."

It is asynchronous: the 202 body is `{"rebase_in_progress": true}`, and "You can poll the [retrieve a merge request] endpoint with the `include_rebase_in_progress` parameter to check the status of the asynchronous request." Terminal states are `{"rebase_in_progress": false, "merge_error": null}` on success and `{"rebase_in_progress": false, "merge_error": "Rebase failed. Please rebase locally"}` on failure (same page). **`merge_error` is the only failure channel** — a 202 tells you nothing about the outcome.

**The parity gap:** GitLab's rebase is a force-push to the source branch, and the docs enumerate three separate 403s for not being allowed to do it, including protected-from-force-push. GitHub's update-branch is a merge commit onto the head branch and needs only Pull requests: write. So the *same* stale-PR fix is materially more likely to fail on GitLab. Rocky's merge Agent needs a documented fallback for GitLab 403 (ask the human, or fall back to a local rebase + push if the branch is pushable) and must handle `"Rebase failed. Please rebase locally"` as a first-class outcome.

---

## 6. Draft state

**GitHub.** Draft at creation is a first-class boolean: `POST /repos/{owner}/{repo}/pulls` takes `draft` — "Indicates whether the pull request is a draft" ([Pulls API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request)). **Flipping draft state is not in REST** — `PATCH /pulls/{n}` has no draft parameter. It is GraphQL: `convertPullRequestToDraft` and `markPullRequestReadyForReview` (introspected input: just `pullRequestId`) ([GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview)). Webhook-observable via `pull_request` actions `converted_to_draft` and `ready_for_review`; PR field `isDraft`.

**GitLab.** Draft is **a title-string convention with no API field.** "Add `[Draft]`, `Draft:` or `(Draft)` to the beginning of the title"; other routes are the **Mark as draft** button, the `/draft` quick action in a comment, or a commit message starting with `draft:`/`Draft:`/`fixup!`/`Fixup!`. To clear it: the **Mark as ready** button, removing the draft prefix from the title, or the `/ready` quick action ([Draft merge requests](https://docs.gitlab.com/user/project/merge_requests/drafts/)). Neither `POST /projects/:id/merge_requests` nor `PUT /projects/:id/merge_requests/:merge_request_iid` has a `draft` parameter ([Create](https://docs.gitlab.com/api/merge_requests/#create-a-merge-request) / [Update](https://docs.gitlab.com/api/merge_requests/#update-a-merge-request)) — the MR object *reports* `draft` as a boolean (with `work_in_progress` deprecated), but you can only *set* it by writing the title. Effect: "Merge requests marked as **Draft** cannot merge until you remove the **Draft** flag, even if they meet all other merge criteria", and `detailed_merge_status` reports `draft_status`.

**Implication for "an exhausted loop leaves a draft":** on GitLab, Rocky must own the title string. Opening as draft = `title: "Draft: <real title>"`; marking ready = `PUT` the title with the prefix stripped. This is fragile in exactly one way that matters — if a human edits the title while the MR is a draft, Rocky's prefix-stripping must be a prefix operation on the *current* title read fresh, never a stored-title replay.

---

## 7. Human review signals (waking a suspended Run)

### 7.1 GitHub

Read reviews with `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` (**Pull requests: read**); each review carries `state`, `body`, `submitted_at`, `commit_id`, `user` ([Pulls / Reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28)). `CHANGES_REQUESTED` is the wake signal. GraphQL adds `reviewDecision` ("The current status of this pull request with respect to code review"), `latestReviews`, `latestOpinionatedReviews` and `viewerLatestReview` — `reviewDecision` is one field for the aggregate verdict instead of reducing a review list yourself ([GraphQL PullRequest](https://docs.github.com/en/graphql/reference/objects#pullrequest)).

Review comments: `GET /pulls/{n}/comments` and `GET /pulls/comments` (**Pull requests: read**). Webhook equivalents: `pull_request_review` (`submitted`, `edited`, `dismissed`) and `pull_request_review_comment` (`created`, `edited`, `deleted`).

Why "changes requested" blocks: "If you enable required reviews, collaborators can only push changes to a protected branch via a pull request that is approved by the required number of reviewers with write permissions", and "If a person with admin permissions chooses the **Request changes** option in a review, then that person must approve the pull request before the pull request can be merged. If a reviewer who requests changes on a pull request isn't available, anyone with write permissions for the repository can dismiss the blocking review." Dismissal via API is gated: "To dismiss a pull request review on a protected branch, you must be a repository administrator or be included in the list of people or teams who can dismiss pull request reviews" ([Reviews API](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28)) — so **Rocky cannot generally clear a blocking review itself.**

Reading the *rules* that make a review or check required, **without admin** — this is the useful discovery: `GET /repos/{owner}/{repo}/rules/branches/{branch}` needs only **Metadata: read** ([fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)), and "Returns all active rules that apply to the specified branch. The branch does not need to exist; rules that would apply to a branch with that name will be returned... All active rules that apply will be returned, regardless of the level at which they are configured (e.g. repository or organization)." Caveat in the same doc: "Rules in rulesets with 'evaluate' or 'disabled' enforcement statuses are not returned" ([Repository rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)). By contrast `GET /repos/{owner}/{repo}/branches/{branch}/protection` requires **Administration: read** — classic branch protection is invisible to a normal developer's token. **So: rules-based repos are legible to Rocky; classic-branch-protection repos are not, and Rocky must degrade to inferring requirements from `BLOCKED` + observed check names.**

Required-check semantics worth encoding: "Required status checks must have a `successful`, `skipped`, or `neutral` status before collaborators can make changes to a protected branch. Required status checks can be checks or commit statuses." And strict vs loose: **Strict** = "Require branches to be up to date before merging" checked, "The branch **must** be up to date with the base branch before merging" (and this "is the default behavior for required status checks"); **Loose** = unchecked, branch "does not have to be up to date" ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). Strict mode is what makes `BEHIND` merge-blocking and thus makes §5's update-branch mandatory rather than cosmetic.

### 7.2 GitLab

Three complementary reads:
- `GET /projects/:id/merge_requests/:merge_request_iid/reviewers` returns per-reviewer `{user, state, created_at}` ([Retrieve merge request reviewers](https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-reviewers)); the documented example shows `unreviewed` and `reviewed`. The full state set is documented in GraphQL as `MergeRequestReviewState` ([GitLab GraphQL reference](https://docs.gitlab.com/api/graphql/reference/#mergerequestreviewstate)): `APPROVED` ("Merge request reviewer has approved the changes"), **`REQUESTED_CHANGES`** ("Merge request reviewer has requested changes"), `REVIEWED`, `REVIEW_STARTED`, `UNAPPROVED` ("Merge request reviewer removed their approval of the changes"), `UNREVIEWED`. GraphQL also exposes MR-level `reviewState`/`reviewStates` filters, though both are marked *"Introduced in GitLab 17.0. Status: Experiment."* — don't build on those two filters.
- **`detailed_merge_status: requested_changes`** ("The merge request has reviewers who have requested changes") — the cheapest single signal, and it arrives on the same MR GET already used for CI and mergeability.
- Approvals: `GET /projects/:id/merge_requests/:merge_request_iid/approvals` returns `approvals_required`, `approvals_left`, `approved`, `approved_by[]` ([Merge request approvals API](https://docs.gitlab.com/api/merge_request_approvals/)). Tiering matters: approval **rules** at project, MR and group level are all "Tier: Premium, Ultimate", but "The following endpoints are available on all tiers, including Free: Approve merge request, Unapprove a merge request, Reset approvals for a merge request, Retrieve approval state for a merge request". `approvals_before_merge` is "Deprecated in GitLab 12.3, use Approval Rules instead".
- Comment/discussion reads are unchanged from the earlier SCM investigation (notes and discussions APIs, note webhook events).

**Tier trap:** "Prevent merge when you request changes" is **"Tier: Premium, Ultimate"**, introduced in 16.11 behind `mr_reviewer_requests_changes`, enabled by default on GitLab.com and Self-Managed in 17.2, flag removed in 17.3 ([Merge request reviews](https://docs.gitlab.com/user/project/merge_requests/reviews/#prevent-merge-when-you-request-changes)). On GitLab **Free**, a reviewer requesting changes does **not** block the merge. So a merge Agent that treats "no blocking signal" as consent will merge over a Free-tier reviewer's objection. Rocky must treat `REQUESTED_CHANGES` as blocking **in its own logic**, independent of whether the platform enforces it. The doc also notes recovery: "the reviewer who requested changes should re-review and approve the merge request" (and since 17.8 they can "Remove a change request") — i.e. **Rocky cannot clear it**, same as GitHub.

---

## 8. Permissions: what a developer's own token actually buys

### 8.1 GitHub fine-grained PAT (extracted from the [permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28))

| Operation | Endpoint | Permission |
|---|---|---|
| Merge a PR | `PUT /repos/{o}/{r}/pulls/{n}/merge` | **Contents: write** |
| Check if merged | `GET /repos/{o}/{r}/pulls/{n}/merge` | Pull requests: read |
| Update PR branch | `/repos/{o}/{r}/pulls/{n}/update-branch` | Pull requests: write |
| Create / edit PR | `POST` / `PATCH /repos/{o}/{r}/pulls` | Pull requests: write |
| Create / submit review | `POST`, `PUT /repos/{o}/{r}/pulls/{n}/reviews` | Pull requests: write |
| List reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews` | Pull requests: read |
| Job logs | `GET /repos/{o}/{r}/actions/jobs/{job_id}/logs` | Actions: read |
| Workflow runs & run logs | `GET /repos/{o}/{r}/actions/runs...` | Actions: read |
| Combined commit status | `GET /repos/{o}/{r}/commits/{ref}/status` | Commit statuses: read |
| **Rules for a branch** | `GET /repos/{o}/{r}/rules/branches/{branch}` | **Metadata: read** |
| List repo rulesets | `GET /repos/{o}/{r}/rulesets` | Metadata: read |
| Own permission level | `GET /repos/{o}/{r}/collaborators/{username}/permission` | Metadata: read |
| **Classic branch protection** | `GET /repos/{o}/{r}/branches/{b}/protection` | **Administration: read** |
| Create repo webhook | `POST /repos/{o}/{r}/hooks` | Webhooks (write) + repo admin |

Two surprises worth designing around. First, **merge needs Contents: write** — a token scoped to "Pull requests" alone can create, review, update-branch and read everything, and then fail at the last step. Rocky's token-validation step must probe Contents: write explicitly and say so up front. Second, `GET /repos/{o}/{r}/collaborators/{username}/permission` under Metadata: read is a cheap pre-flight for "does this developer even have write on this repo".

GitHub bypass behaviour to be aware of: "By default, the restrictions of a branch protection rule don't apply to people with admin permissions to the repository", and admins can turn on "Do not allow bypassing the above settings" to apply restrictions to themselves too ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). `viewerCanMergeAsAdmin` is the GraphQL read of that state. Rocky should not rely on bypass; if the developer happens to be an admin, merging still works, but the map must assume they are not.

### 8.2 GitLab

Token scopes ([Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)): `api` is the coarse read-write scope needed for merge, rebase and MR writes; `read_api` suffices for the CI/mergeability polling loop. Expiry: "If you do not enter a date, the expiry date is set to 365 days from today"; "By default, the expiry date cannot be more than 365 days from today", extended to 400 days from 17.6 behind `buffered_token_expiration_limit`. There is no short-lived-token story for a PAT — Rocky must handle expiry as a first-class error.

The harder limit is **role**, not scope. Two independent gates:

1. **Merging is governed by protected-branch settings, and Developer is often not enough.** "The default branch for your repository is protected by default." The instance/group default protection level default is **Fully protected** — "Default value. Developers cannot push new commits, but maintainers can" ([Default branch](https://docs.gitlab.com/user/project/repository/branches/default/)). The **Allowed to merge** setting "Controls who can merge changes through merge requests and create new protected branches through the UI and API", and its "Default behavior (not configured)" is documented as **"No one can merge (unless they have Allowed to push and merge)"**. The docs then give an explicit truth table for the Developer role ([Protected branches](https://docs.gitlab.com/user/project/repository/branches/protected/#permission-combinations-for-developer-role)):

   | Allowed to merge | Allowed to push and merge | Direct push | Merge through MR |
   |---|---|---|---|
   | No one | Developers + Maintainers | yes | yes |
   | Not configured | Developers + Maintainers | yes | yes |
   | Developers + Maintainers | Not configured | no | **yes** |
   | Not configured | Not configured | no | **no** |
   | Maintainers | Not configured | no | **no** |
   | Maintainers | Maintainers | no | **no** |
   | Developers + Maintainers | Maintainers | no | **yes** |

   Three of seven documented configurations leave a Developer unable to merge at all. The recommended production configuration in the same doc is exactly one of them: "For branches deployed to production environments: Set **Allowed to merge** to **Maintainers** only." **This is the map's biggest exposure: on a typical GitLab project with a protected default branch, the developer whose token Rocky holds may have no merge right whatsoever, and the merge Agent's only correct move is to hand off to a human.** The failure is legible — `401 Unauthorized` from the merge endpoint, "This user does not have permission to accept this merge request" — so detect it, don't retry it.

2. **Rebase needs push-to-source-branch, including force-push.** See §5's three 403s. A source branch that is itself protected from force push makes the server-side rebase unavailable.

Reading the config: `GET /projects/:id/protected_branches` is "Tier: Free, Premium, Ultimate" and returns `merge_access_levels[]` / `push_access_levels[]` with levels `0` (No access), `30` (Developer), `40` (Maintainer), `60` (Administrator, self-managed only) ([Protected branches API](https://docs.gitlab.com/api/protected_branches/)). **The docs do not state a minimum role for the list endpoint** — unlike the webhook endpoints, which state Maintainer+ explicitly. Treat "can a Developer read protected-branch config?" as an **open item to verify against a real instance**, because Rocky's ability to pre-flight "will my merge be refused?" depends on it. If it turns out to require Maintainer, the fallback is to attempt the merge and classify the 401.

Merge trains add a role floor of their own: "You must have the Developer, Maintainer, or Owner role" for the train API, plus the Maintainer role "to merge or push to the target branch" per the trains feature doc ([Merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)).

---

## 9. Divergences that constrain the design

1. **Webhooks require admin on both platforms.** Polling is not a fallback, it is the design. The ephemeral tunnel is irrelevant to this map.
2. **Polling economics are inverted.** GitHub: tight hourly budget, rescued by free `304`s and `x-poll-interval`. GitLab: enormous per-minute budget, no documented conditional-request discount. The same poller tuned for one platform is wrong for the other.
3. **Mergeability expressiveness is wildly asymmetric.** GitLab's 24-value `detailed_merge_status` names the blocker; GitHub's `BLOCKED` does not. Model on GitLab's vocabulary and synthesise it on GitHub from `MergeStateStatus` + branch rules + review state.
4. **"Merge when ready" is the portable primitive; plain merge is not.** GitHub `enablePullRequestAutoMerge`, GitLab `auto_merge=true`. Both are queue/train-aware, so one path covers queued and unqueued repos.
5. **GitHub's auto-merge lives only in GraphQL**, as do draft toggling, merge-queue enqueue, and server-side rebase. **A REST-only GitHub client cannot implement this map.** The GitHub adapter must speak both REST and GraphQL.
6. **Rocky's own fix push cancels GitLab auto-merge but not GitHub auto-merge.** GitLab: "If you add new commits to the merge request, GitLab cancels the request". GitHub: only disabled when someone *without* write access pushes. The merge Agent must re-arm on GitLab after every fix iteration.
7. **Rebase is likelier to be refused on GitLab** (three documented 403s including force-push protection) than GitHub's update-branch (Pull requests: write). And on GitHub, update-branch can *dismiss a stale approval* — a fix that costs a human gate.
8. **GitLab draft is a title string.** No API boolean on create or update. Prefix discipline, always derived from a freshly-read title.
9. **Tier cliffs on GitLab:** merge trains Premium+, blocking "request changes" Premium+, approval *rules* Premium+ (approve/unapprove Free), external status checks Ultimate. A Free-tier GitLab project silently enforces less than Rocky assumes — Rocky must enforce review gates itself rather than trusting the platform to.
10. **Merge permission is a role question on GitLab and a token-permission question on GitHub.** GitHub: Contents: write (surprising, and easy to under-scope). GitLab: membership of **Allowed to merge**, which a Developer frequently is not.
11. **Queue/train ejection is a quiet failure on both.** GitHub removes the PR from the queue on a failing merge-group status; GitLab removes it from the train and restarts everything behind it. In both cases "no longer queued and not merged" is the observable — a positive timeout and re-check is mandatory.
12. **Log fetching is unbounded on both.** No size cap, no range parameter, no server-side tail. GitHub adds a 1-minute expiry on the signed log URL.
13. **Reading merge requirements without admin works on GitHub only for ruleset-based repos**, and its status on GitLab is undocumented. Classic-branch-protection GitHub repos are opaque to a developer token.

---

## 10. The cheapest design that satisfies both

The goal is one internal model with two thin adapters, and the smallest number of moving parts that survives both platforms' constraints.

### 10.1 One poll loop, one state object

**Poll the PR/MR object, not the CI system.** On GitLab this is literally sufficient: a single `GET /projects/:id/merge_requests/:iid` returns `detailed_merge_status` (which already distinguishes `ci_still_running`, `ci_must_pass`, `need_rebase`, `conflict`, `not_approved`, `requested_changes`, `draft_status`), plus `head_pipeline`, `has_conflicts` and `draft`. On GitHub it takes two calls — `GET /pulls/{n}` (for `mergeable`/`mergeable_state`) and `GET /commits/{ref}/check-runs` — both with ETags so steady-state polls are free.

Normalise into one internal enum shaped like GitLab's `detailed_merge_status`, because it is the strict superset. The GitHub adapter derives it:

| Internal | GitHub derivation |
|---|---|
| `checking` | `mergeable == null` or `mergeStateStatus == UNKNOWN` |
| `conflict` | `mergeStateStatus == DIRTY` |
| `need_rebase` | `mergeStateStatus == BEHIND` |
| `ci_still_running` | any required check `status != completed` |
| `ci_must_pass` | any required check `conclusion` outside {`success`,`skipped`,`neutral`} |
| `requested_changes` | `reviewDecision == CHANGES_REQUESTED` |
| `not_approved` | `reviewDecision == REVIEW_REQUIRED` |
| `draft_status` | `isDraft` |
| `mergeable` | `mergeStateStatus` in {`CLEAN`,`HAS_HOOKS`} |
| `blocked_unknown` | `BLOCKED` with no explanation found — **escalate to human** |

That last row is the honest cost of GitHub's thin reporting, and it is the only place the two platforms cannot be made to agree. Keeping it as an explicit internal state (rather than pretending to know) is what keeps the design cheap.

Poll cadence: fixed interval, ETag-conditional on GitHub, honouring `x-poll-interval` and backing off on `RateLimit-Remaining`/`Retry-After` on GitLab. Because GitHub's `304`s are free, a 10–15 s cadence per active PR is affordable; GitLab's 2,000/min makes any sane cadence free outright. **Webhooks, if a maintainer ever configures one, are a latency optimisation that shortens the next poll — never a separate code path.**

### 10.2 Fix loop: metadata first, logs second

1. Detect red from the state object (`ci_must_pass`).
2. Enumerate only failing units: GitHub `runs/{run_id}/jobs` → jobs with `conclusion == failure`, then their failing `steps[]`; GitLab `pipelines/:id/jobs?scope=failed`.
3. Fetch logs only for those, with a bounded tail plus pattern-matched earlier lines. On GitHub, follow the 302 immediately (1-minute expiry).
4. Hand the fixer Agent the structured failure list first and the truncated log second.

This ordering is what keeps log volume — the one genuinely unbounded thing in the whole surface — off the critical path.

### 10.3 Merge: exactly one primitive per platform

**Do not implement "merge now" as the primary path, and do not implement queue/train handling separately.** The cheapest correct merge Agent is:

- **GitHub:** GraphQL `enablePullRequestAutoMerge(pullRequestId, expectedHeadOid, mergeMethod)`. It satisfies "use the platform's real merge action", it waits for required reviews and checks server-side, and it routes into the merge queue when the base branch has one (evidenced by the merge-queue notes on its own inputs). Fall back to `PUT /pulls/{n}/merge` with `sha` only when `viewerCanEnableAutoMerge == false` and the state is already `mergeable` — i.e. when the repo has no protection at all and auto-merge is therefore unavailable.
- **GitLab:** `PUT /projects/:id/merge_requests/:iid/merge` with `auto_merge=true` and `sha`. On instances ≥ 19.1 this is train-aware by itself. Below 19.1, and only there, use `POST /projects/:id/merge_trains/merge_requests/:iid`.

Always pass the head-SHA guard (`expectedHeadOid` / `sha`). Normalise 405→"re-read state", 409→"head moved, re-read and retry", GitLab 401→"this developer cannot merge this branch; escalate".

After arming, keep polling. Success is `merged == true` / `state == merged`. Failure is *ejection*: GitHub `mergeQueueEntry` becoming `null` while unmerged, or GitLab's train entry disappearing while unmerged, or GitLab's auto-merge being cancelled by Rocky's own fix push. **Re-arm after every fix iteration on GitLab.**

### 10.4 Staleness

Prefer the platform's action, and never push locally:
- GitHub `BEHIND` → `PUT /pulls/{n}/update-branch` with `expected_head_sha`. Only do this when required checks are strict (read from `rules/branches/{branch}`), because it can dismiss a stale approval.
- GitLab `need_rebase` → `PUT .../rebase`, then poll with `include_rebase_in_progress` until `rebase_in_progress: false` and check `merge_error`. Handle the three 403s and `"Rebase failed. Please rebase locally"` as an escalation, not a retry.

### 10.5 Draft, and the exhausted loop

- GitHub: create with `draft: true`; flip with GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft`.
- GitLab: own the title. Create as `"Draft: <title>"`; mark ready by re-reading the current title and stripping the prefix.

An exhausted loop leaves a draft on both, which is enforced identically at merge time (`draft_status` / `isDraft` blocks merge).

### 10.6 Human gates

- Wake on `requested_changes`: GitHub `reviewDecision == CHANGES_REQUESTED`; GitLab `detailed_merge_status == requested_changes` (both already in the single state object — **no extra poll**).
- **Enforce it in Rocky regardless of tier.** On GitLab Free, requesting changes does not block; Rocky must block anyway.
- Accept that Rocky cannot clear a blocking review on either platform. Dismissal needs admin/dismisser rights on GitHub; on GitLab only the requesting reviewer can clear it.

### 10.7 Pre-flight, once per repo

Cheap, and it prevents the whole class of "worked until the last step" failures:
- GitHub: `GET /repos/{o}/{r}/collaborators/{username}/permission` (Metadata: read) for write access; `GET /repos/{o}/{r}/rules/branches/{branch}` (Metadata: read) for required checks and strictness; probe **Contents: write**; note when only classic branch protection exists (`rules/branches` empty but merges blocked) and mark the repo "requirements opaque".
- GitLab: instance version (for the 19.1 auto-merge/train behaviour); tier (trains, blocking request-changes, approval rules); `GET /projects/:id/protected_branches` to predict merge refusal — **and treat its role requirement as unverified**, falling back to classifying the merge 401.

### 10.8 What this buys, and what it costs

Total moving parts: one poller, one normalised mergeability enum, one "arm auto-merge" call per platform, one staleness action per platform, one title/GraphQL draft shim, and a per-repo pre-flight. No webhook infrastructure, no tunnel dependency, no separate merge-queue subsystem.

The costs the design must accept rather than engineer away:
- GitHub `BLOCKED` with classic branch protection is genuinely opaque → escalate.
- GitLab Developers may simply lack merge rights → escalate.
- GitLab Free enforces fewer gates than Rocky does → Rocky enforces its own.
- Log size is unbounded → truncation is Rocky's job.

### 10.9 Map assumptions this invalidates or narrows

1. **"Webhooks + tunnel deliver CI completion" — invalidated.** Neither platform lets a non-admin create the hook. Polling is the mechanism; the tunnel is not needed for this map.
2. **"The merge Agent calls the merge API" — narrowed.** It should arm auto-merge, not merge. Plain merge is the no-protection fallback only.
3. **"Merge queue / merge train needs its own subsystem" — invalidated.** Both platforms route the auto-merge primitive into the queue/train. One path.
4. **"A REST client is enough for GitHub" — invalidated.** Auto-merge, enqueue, draft toggling and server-side rebase are GraphQL-only.
5. **"Both platforms tell us why a merge is blocked" — invalidated for GitHub.** `BLOCKED` is one bucket; the design needs an explicit "blocked, reason unknown" state.
6. **"A developer's token can merge" — narrowed on both.** GitHub needs Contents: write specifically; GitLab needs membership of **Allowed to merge**, which the documented recommended production configuration denies to Developers.
7. **"The platform blocks merge when changes are requested" — invalidated for GitLab Free.** Rocky must enforce the gate itself.
8. **"Rocky can move a stale branch forward unaided" — narrowed on GitLab**, where rebase is a force-push that protection may forbid, and **qualified on GitHub**, where update-branch can dismiss the approval the merge is waiting for.
9. **"Rocky's fix push is inert" — invalidated on GitLab.** It cancels auto-merge. Re-arm every iteration.

---

## Open items to verify against live instances

1. Does `GET /projects/:id/protected_branches` succeed for a Developer-role token? The docs state no minimum role, unlike the webhook endpoints which state Maintainer+ explicitly. Determines whether Rocky can pre-flight merge refusal on GitLab or must discover it via 401.
2. Confirm `enablePullRequestAutoMerge` enqueues (rather than errors) on a base branch with an active merge queue. The mutation's own input descriptions imply it, and the merge-queue doc confirms a write-access user can enqueue, but no single doc sentence states the composition outright.
3. Actual failure mode when a merge-queue repo's CI does not handle `merge_group`: presumed indefinite `AWAITING_CHECKS` until the configured "Status check timeout" fires. Determines Rocky's own timeout value.
4. GitLab job-trace practical size and whether any transport-level truncation occurs; the API docs specify no cap.
5. Whether GitLab returns usable `ETag`/`If-None-Match` behaviour in practice on MR GETs even though it is undocumented — would be a bonus, must not be depended on.
