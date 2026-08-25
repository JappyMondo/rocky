# CONTEXT

Glossary of the agent-rocky-reviewer domain. Terms are canonical: use them exactly as defined here in code, tickets, and UI copy.

## Terms

- **Rule**: One short prose review instruction with a handle: id, status, provenance (`bootstrap` / `learned` / `manual`), timestamps. The LLM consumes only the prose; the metadata exists so the UI and Learnings can point at individual rules. Rules are always per-repo.
- **Rule status**: `active`, `disabled`, or `tombstoned`. Tombstoned rules are never deleted and never re-proposed; there is no true deletion.
- **Tombstone**: A rejected, reverted, or user-deleted rule kept as a "do not re-propose" record. Fed to the Learning pass only — never to the Review prompt.
- **Bootstrap**: The one AI pass at repo-install that mines the checkout (structure, commit history, existing agent docs like CLAUDE.md / CONTRIBUTING) and proposes the initial rule set. The user confirms it with per-rule checkboxes as a step of the add-repo flow; reviews start only after that step.
- **Review prompt**: Plain concatenation of the global, user-editable system prompt plus the repo's active rules. No templating. Tombstones and noise instructions are not part of it.
- **Feedback**: Replies to Rocky's comments and 👍/👎 reactions on them. Thread-resolution is not a feedback signal. Only feedback from authorized authors mutates rules.
- **Authorized author**: A user whose feedback counts for learning: has write access to the repo, adjusted by the repo's optional author whitelist (adds non-write users) and blacklist (mutes write users).
- **Feedback sweep**: The single API fetch at PR/MR merge or close that collects all Feedback on Rocky's comments in that PR. No live feedback ingestion, no reaction polling during the PR's lifetime.
- **Learning pass**: The batched AI pass run on a Feedback sweep. It may create, edit, disable, or leave rules unchanged ("if they are fine, they are fine"), filters noise and nitpicks, and receives Tombstones to avoid re-proposing them. Changes auto-apply.
- **Consolidation pass**: A weekly AI pass per repo that merges overlapping rules and prunes redundancy. Skipped when no rule changes happened since the last run. Its changes are ordinary Rule changes in the Learnings.
- **Rule change**: One append-only audit record: rule id, action (`created` / `updated` / `disabled` / `reverted`), old text → new text, one-line AI rationale, cause (SCM permalinks to the PR and feedback that triggered it, or "bootstrap" / "consolidation"), timestamp.
- **Learnings**: The web UI view rendering the Rule change log, newest first, grouped by PR — "how each piece of feedback shaped the rules". Each entry offers one-click revert.
- **Review run**: One execution of Rocky's review against a PR/MR head. States: `queued` (debouncing), `running`, then exactly one of `completed` / `failed` / `superseded` (a newer push replaced it) / `cancelled` (PR closed). A run interrupted by a service restart returns to `queued` and re-runs from scratch against the current head; runs are never resumed mid-flight. There is one review mode: every run sees the full PR diff, with Rocky's open comments passed as prior context ("resolve what the push addressed, don't repeat the rest").
- **Trigger**: An event that starts a Review run: PR/MR opened, real code push, marked ready-for-review, re-request (Rocky requested as reviewer), or an `@rocky review` comment from an Authorized author. Draft PRs are skipped unless commanded. Pushes are debounced; a push during a running review supersedes it (cancel and restart).
- **Approval gate**: The hold on fork PRs from non-authorized authors: each push waits, unreviewed, until an Authorized author comments `@rocky review` — approval is per push, never per PR. Same-repo branches and forks of Authorized authors are never gated.
- **Report-only check**: Rocky's check states "a review ran", never "the code is bad". Findings never fail the check; internal errors never block a merge. The only merge-holding state is pending while a run is active, and only in repos that opt into Merge-wait.
- **Merge-wait**: Opt-in repo-side configuration (offered during the add-repo flow) that makes a merge wait for a running Review run to finish.
- **Thread conversation**: Rocky replying on his own comment threads like a human reviewer: answers any human's question, asks for clarification when a discard is ambiguous, and resolves a thread only on a confident discard from an Authorized author or when a push addresses the finding. Capped at 5 Rocky replies per thread; bot comments are never answered.
