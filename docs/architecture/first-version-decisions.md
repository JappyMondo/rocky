# First-version architecture decisions

Planning baseline: concept commit `5bb89a7d376565749c3f2bab9b67462bcb097afc`; Taskbot architecture ticket 2, acceptance ticket 9. This is a reviewable design contract, not an implementation claim.

One TypeScript application owns explicit delivery transitions. SQLite transactions, append-only events, fenced ownership, version identities, evidence and effect intents exist before real external writes. A run resumes its persisted stage; an agent conversation is never the authority for delivery. Large immutable artifacts live in files referenced by manifests.

| Owned module | Small interface and responsibility |
| --- | --- |
| coordinator | Admit, advance, steer, cancel, approve; scope revisions, budgets and deterministic gate |
| store | Claim/fence, transition, append event, persist intent and reconciliation receipt |
| evidence | Record immutable receipts/artifacts, validate input identity, render recorded facts |
| runner | Execute owned commands/browser sessions, enforce deadlines and process cleanup |
| attraccess | Inspect compatibility, prepare fixtures, derive checks and execute approved scenarios |
| agents | One typed implement/repair/review harness with explicit tool completion |
| integrations | GitHub and Linear observation/effects with stable operation identity |
| config/operator | Effective provenance, build identity, controls and truthful state projections |
| acceptance | Independent behavioral contract and protected evaluation corpus |

Use narrow internal seams, without a public plugin registry or arbitrary workflow engine. Adapter policy owns repository command names; the coordinator does not. Keep code verification, live readiness, publication, approval, merge and tracker closeout as distinct facts. CI observation and its repair reserve are independent of review exhaustion.

Initial budget interpretation for later coordinator implementation: one environment retry; two product/CI repair attempts with one reserved for CI; one review correction and one disagreement decision; declared wall/time-token limits. These are recorded starting policy, not proven optimal values. Calibration may change a future version before a scored batch, never retroactively erase failures.

Concept section 13 mentions a measured second worker while sections 1/5 start with one active implementation. The first version must prove competing-worker safety and resource measurements while enforcing one implementation owner. Actual concurrent coding or a second repository adapter follows the evidence gate and an explicit scope decision; it is not silently claimed complete.

Rocky source development remains on the exact `rocky-next` worktree/branch. Reading Attraccess is permitted. Disposable Attraccess environment writes and target coding/remote qualification have distinct unresolved authority scopes in Taskbot ticket 4. Local fake effects are permitted foundation proof; they do not remove live acceptance gates. Protected merge always requires exact-revision human approval.

Required first slice: installable local package, versioned effective configuration/build identity, transactional run/lease/outbox store, immutable receipts and owned commands. Acceptance F01-F11 describes observable invariants. Production implementation begins only after a different reviewer approves this contract; the contract author cannot self-approve it.
