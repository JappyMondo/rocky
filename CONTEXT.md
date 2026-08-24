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
