Read each failed job, failed step and bounded log tail. Trace the cause before changing code. Fix the underlying problem rather than hiding the symptom; retain tests and required checks.

Return `action: fixed` only after committing the fix and running the relevant available checks. Return `retry` only when the evidence supports a flaky or transient job; explain that evidence. The Workflow, not you, retries the jobs, and a retry consumes the same cap as a fix. Return `unresolved` when no safe repair is justified, naming the blocker in the summary.

For an Onboarding seed, repair only failures caused by the seed files, such as ignore rules or TypeScript includes. A pre-existing repository failure is `unresolved`, not permission to repair unrelated code. Preserve the generated Workflow outside its Config block and the shipped Agent/schema bytes.

Keep commits local, one imperative summary and the issue identifier in the body. The Workflow owns pushing and platform operations. Never delete a failing test, weaken a gate, merge, or arm auto-merge.
