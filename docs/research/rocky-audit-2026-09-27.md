# Rocky audit: source, configuration, runs, and delivery gaps

Snapshot: **27 September 2026**, inspected with the daemon stopped. Read-only runtime audit; the new documents do not change profiles, workflows, runs, services, PRs, or target repositories.

Companion to the [rebuild concept](../rocky-next-concept.md). Counts describe retained local evidence, not all historical attempts or an independently controlled success-rate benchmark.

## 1. Source and installation identity

- Checkout and remote main: `4c5577caab4d70e24c623189b3f3d776af84ad4d`; branch `t3code/rebuild-rocky-workflow`.
- Source package and both global installations report `0.2.0`.
- `rocky status` reported no daemon answering on `127.0.0.1:7625`; MCP reads failed consistently and no listener was found. Runtime was not restarted.
- Homebrew and NVM installations have matching inspected bundle hashes. They are not identical in behavior to checked-out main: installed code includes mechanisms from open PR #53. No embedded build-commit receipt was found in the inspected package metadata.

- `dist/flow-runtime.js` SHA-256: `932d6e007bdca2b91d1402b555ac0aef52800853af809f410d7fdef76023825d`.
- `dist/boot-child.js` SHA-256: `4b227586c7e9af5b99c07567a3ae1929b361118b5fad9888dd62396e506e264d`.

## 2. Code coverage map

Inventory: **441 tracked files** under `packages/`, `apps/`, and `tools/`. The table covers major subsystem boundaries, source contracts and their tests. Production paths, failure-related code, docs, shipped prompts/flows, and PR #53 changes were inspected in more detail. This is not a claim of a line-by-line correctness audit, execution of every test, or live verification of unused integrations.

| Area | Files | Responsibility | Rebuild implication |
| --- | --- | --- | --- |
| [packages/daemon/src/run](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/run) | 69 | Scheduling, worker ownership, frozen snapshots, agent sessions, positional replay, controls and retries | Keep durable semantics; simplify state transitions and version ownership |
| [packages/daemon/src/flow](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/flow) | 22 | Graph execution, agent attachment resolution, delivery/review/CI loops, fixtures, command execution | Replace general graph surface with one workflow; separate environment from product repair |
| [packages/daemon/src/environment](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/environment) | 3 | Capability setup and verification, readiness budgets, recovery | Build a tested Attraccess recipe; preserve machine-readable verification |
| [packages/daemon/src/scm](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/scm) | 17 | GitHub/GitLab checks, logs, review threads, merge protection | Retain GitHub boundary and current-head proof; defer GitLab |
| [packages/daemon/src/linear](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/linear) | 26 | Delegation, OAuth, comments, activities, steering, durable effects | Keep integration; isolate publication outages from engineering progress |
| [packages/daemon/src/harness](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/harness) | 30 | Codex, Claude Code, OpenCode streams and continuation | Qualify one harness; keep narrow replacement interface |
| [packages/daemon/src/config](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/config) | 28 | Profiles, execution catalog, source-control identity, model slots, redaction | Shrink configuration and expose effective provenance |
| [packages/daemon/src/mcp](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/mcp) | 9 | Server definitions, authentication, control server | Keep only tools actually required; deterministic browser runner is not an agent tool lottery |
| [packages/daemon/src/repos](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/repos) | 17 | Clones, worktrees, ownership, cleanup, locks | Preserve unpublished work; test admission and cleanup under pressure |
| [packages/daemon/src/review-report](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/review-report) | 11 | Inventory, narrative, capture, audit and publication | Render reports from existing artifacts; use AI only for useful explanations |
| [packages/daemon/src/local-api](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/local-api) | 10 | Run controls, artifacts, settings, configuration and presentation | Retain operational access; simplify operator states |
| [packages/cli](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/cli) | 38 | Lifecycle, profiles, service installation, doctor, MCP and stub commands | Make the small supported surface complete |
| [packages/local-contracts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/local-contracts) | 8 | Configuration, flow and presentation contracts | Use narrow typed boundaries, not a general node language |
| [packages/sdk](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/sdk) | 12 | Workflow context, triggers, SCM types | Internal interfaces first; public workflow SDK deferred |
| [apps/web](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/apps/web) | 72 | Run inbox, traces/diffs, review reports, flow and profile editors | Keep run/evidence UX; defer authoring UI |
| [tools](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/tools) | 8 | Distribution checks, packaging and operational repair helpers | Immutable release identity and clean-install smoke remain valuable |

Other inspected boundaries include server/lifecycle composition, private/public ingress, packaged content, architecture/ADRs, CI, and distribution. Source docs retain historical decisions (including repo-vendored workflows); current profile/loading code takes precedence. The fixed Attraccess-first successor is a new design, not a retroactive description of Rocky.

## 3. Default, configured, and captured workflows

| Layer | Observed behavior |
| --- | --- |
| Shipped JSON | 167 nodes, 185 edges; 31 agent attachment nodes; reviewCap 5, ciCap 3; version-gated recovery behavior |
| Active profile | One active attraccess profile, configurationVersion 1; one GitHub repository, no repo groups; backups are not additional profiles |
| Effective local flow | profiles/flows/attraccess.json: 167 nodes, 196 edges; parsed content equals embedded profile workflow source |
| Leftover TypeScript | profiles/attraccess.workflow.ts exists but JSON profile loading does not consult it |
| Materialized automation | Local reviewCap 25, ciCap 15, maxTransitions 500; repository command/service catalog injected at admission |
| Frozen snapshot | Per-run workflow/profile captures effective configuration; admission adds version flags. Old snapshots do not automatically acquire all new flags |
| Runtime implementation | Shared installed coordinator/runner code still matters; frozen content alone does not isolate behavior from runtime upgrades |

Control path: clarify → plan → implement/open draft → validate → compliance → UI → review → CI → recap → publish → approval → merge. No-code comment delivery and manual PR-conversation handling are separate branches. Many failures return to validation; coordinator code can inspect CI before the displayed CI node.

Current role choices: planner and review use Codex `gpt-6-sol`, high effort; implementation uses Codex `gpt-6-luna`, medium effort. Instance default is Luna/medium; profile role selections control these runs. No controlled comparison establishes that these choices caused the failures.

Browser MCP: pinned `@playwright/mcp@0.0.82`, headless and isolated. Shipped graph attaches it to the UI inspector; the current profile attaches it to twelve agent nodes. PR #53 additionally passes configured inspector tools to fixture preparation. Having a tool grant did not establish deterministic authentication, fixture readiness, or complete browser coverage.

Source: [packages/daemon/src/config/profiles.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/config/profiles.ts), [packages/daemon/src/run/snapshot.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/run/snapshot.ts), [packages/daemon/content/.rocky/workflow.json](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/content/.rocky/workflow.json), [packages/daemon/src/flow/delivery.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/daemon/src/flow/delivery.ts).

## 4. Configured Attraccess commands and services

These are observed configured commands, not a recommendation to run them during this audit. Shell initialization uses the local NVM installation. Most build/test commands have a 30-minute timeout.

| ID | Selection policy | Timeout | Command / behavior | Dependencies |
| --- | --- | --- | --- | --- |
| install | required | 1800 s | `./scripts/setup-dev-dependencies.sh` | — |
| test | required | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=test --exclude=tag:scope:hardware,tag:type:plugin` | attraccess/install |
| lint | required | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=lint --exclude=tag:scope:hardware,tag:type:plugin` | attraccess/install |
| typecheck | required | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=typecheck --exclude=tag:scope:hardware,tag:type:plugin` | attraccess/install |
| build | required | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=build --exclude=tag:scope:hardware,tag:type:plugin` | attraccess/install |
| e2e | agent | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=e2e --exclude=tag:scope:hardware,tag:type:plugin` | attraccess/install |
| plugins | agent | 1800 s | `pnpm nx affected --base=origin/main --parallel=3 --target=lint,test,e2e,pack-test --exclude='*,!tag:type:plugin'` | attraccess/install |
| verify-runtime | agent | 60 s | `Verify pinned Node/pnpm and installed Nx; emit JSON checks` | — |
| verify-web | agent | 30 s | `HTTP-check frontend and API /api/info at discovered endpoints; emit JSON checks` | — |
| seed-ui | required | 120 s | `export STORAGE_ROOT="$ROCKY_LEAD_REPO/storage"; pnpm seed:dev -- --demo` | attraccess/install |
| firmware-setup | agent | 1800 s | `INSTALL_ESP_IDF=true ./scripts/setup-dev-dependencies.sh` | attraccess/install |
| firmware-build | agent | 1800 s | `pnpm nx build attractap-firmware` | attraccess/firmware-setup |

One service, `attraccess/web`, launches `pnpm serve` with run-local STORAGE_ROOT. API/frontend URLs come from `.dev-serve-ports.json`; service readiness permits 120 attempts at one-second intervals. Environment capabilities are baseline runtime and optional browser. Seed success and HTTP readiness do not establish feature-specific fixtures.

Instance concurrency is 3. Retention is 100 terminal runs and 40 runs with sessions/screenshots. Bot Git/SSH/signing and GitHub configuration are selected independently of personal defaults; no credentials are copied into this report. The current profile includes host-side firmware validation because the coding sandbox does not supply all required host capabilities.

Attraccess source inspected at run ATT-764-8 head `372d52b395996c2c351009ebf5d78dc5f18dd786`: AGENTS.md, package scripts, and pull-request CI. CI includes core lint/typecheck/test/e2e, plugin validation/packaging, CRAP reporting, firmware-version rules and additional guards. The profile catalog is not a complete substitute for actual required CI. Nx base/head must be recorded, not allowed to drift invisibly during a run.

## 5. CLI and validation surface

| Surface | Implemented status |
| --- | --- |
| setup; start/stop/restart/status/logs; doctor; service install/uninstall | Implemented lifecycle and diagnostics |
| repo add/list/remove; profile list/export/import/use/seed/delete | Implemented repository/profile management |
| exec --profile; mcp serve and connection commands | Implemented identity-context command execution and MCP control/auth surfaces |
| init; upgrade; trigger <name> <issue> | Explicit stubs in current commands.ts; manual triggering exists through local API/MCP instead |

Sources: [packages/cli/src/cli.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/cli/src/cli.ts), [packages/cli/src/commands.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/cli/src/commands.ts), [packages/cli/src/source-control.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/cli/src/source-control.ts), [packages/cli/src/mcp.ts](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/packages/cli/src/mcp.ts). Some historical docs describe upgrade behavior more broadly than current CLI code.

Rocky CI runs formatting; affected/all build, typecheck and lint; tests with coverage; clean distribution smoke; dependency audit and PR dependency review; required aggregate `ci`. Green Rocky CI verifies its tested contracts, not unattended Attraccess success. This documentation audit did not rerun the runtime test suite or install a new build. Source: [.github/workflows/ci.yml](https://github.com/JappyMondo/rocky/blob/4c5577caab4d70e24c623189b3f3d776af84ad4d/.github/workflows/ci.yml).

## 6. Unmerged Rocky PRs

**One open PR:** [#53 — Recover validation, service, and browser fixture failures](https://github.com/JappyMondo/rocky/pull/53), `4c597d687b707af4d747a16313933b433603cf00`, review required. check, audit, dependency-review and aggregate ci were successful at inspection.

| Change reviewed in #53 | Design lesson |
| --- | --- |
| Keep partial output from timed-out commands; old snapshots get host-validation responsibility | Diagnostic artifacts and command ownership are durable contracts |
| Serialize repository service startup until readiness/cleanup | Ports and process lifetime need explicit ownership |
| Fixture preparation inherits configured browser tools; prefer configured tools | Tool wiring alone is not a repeatable fixture recipe |
| Unavailable GitHub log retains failed-job metadata and fixer path | Partial evidence must not collapse the recovery route |
| Supply current-run evidence locations to delivery reviewers | Consumers must receive authoritative evidence directly |
| CI polling replays UI receipt without probing a deliberately stopped service | Historical verification and live readiness have different lifetimes |

The PR contains focused regression tests, including a pre-change readiness journal. Local and PR test claims do not prove a fresh run completes. Existing installed copies contain these mechanisms, but a matching full release manifest was not established.

Closed but unmerged historical PRs (inventoried, not treated as active pending fixes): [#43](https://github.com/JappyMondo/rocky/pull/43), [#26](https://github.com/JappyMondo/rocky/pull/26), [#25](https://github.com/JappyMondo/rocky/pull/25), [#24](https://github.com/JappyMondo/rocky/pull/24), [#23](https://github.com/JappyMondo/rocky/pull/23), [#22](https://github.com/JappyMondo/rocky/pull/22), [#21](https://github.com/JappyMondo/rocky/pull/21), [#19](https://github.com/JappyMondo/rocky/pull/19), [#18](https://github.com/JappyMondo/rocky/pull/18), [#17](https://github.com/JappyMondo/rocky/pull/17), [#16](https://github.com/JappyMondo/rocky/pull/16), [#15](https://github.com/JappyMondo/rocky/pull/15), [#1](https://github.com/JappyMondo/rocky/pull/1). Their subject matter includes early scaffolding, adapters, workflow content, controls, distribution, and theme work. Current code, not those abandoned branch labels, is the behavior authority; their full historical diffs were not separately audited.

## 7. Every retained run

Headers are persisted state. Boot count includes replay/poll passes, not just fresh coding attempts. `finished/exhausted` is not success. No retained coding run has a completed/merged terminal receipt.

| Run | Status / outcome | Boots | Last recorded stage |
| --- | --- | --- | --- |
| ATT-1079-1 | cancelled | 4 | Implement |
| ATT-1079-2 | finished/exhausted | 1 | Needs attention |
| ATT-1079-3 | finished/exhausted | 35 | Needs attention |
| ATT-1079-4 | failed | 161 | Compliance |
| ATT-1079-5 | finished/exhausted | 38 | Needs attention |
| ATT-1089-1 | cancelled | 2 | Implement |
| ATT-1089-2 | finished/exhausted | 1 | Needs attention |
| ATT-1089-3 | finished/exhausted | 15 | Needs attention |
| ATT-1089-4 | finished/exhausted | 44 | Needs attention |
| ATT-1089-5 | running | 146 | Review |
| ATT-1098-1 | failed | 43 | Compliance |
| ATT-1098-2 | failed | 9 | Clarify |
| ATT-1098-3 | failed | 216 | Validate |
| ATT-1098-4 | finished/exhausted | 290 | Needs attention |
| ATT-764-1 | failed | 7 | Environment: verifying |
| ATT-764-2 | failed | 1 | Implement |
| ATT-764-3 | finished/exhausted | 38 | Needs attention |
| ATT-764-4 | finished/exhausted | 4 | Needs attention |
| ATT-764-5 | finished/exhausted | 9 | Needs attention |
| ATT-764-6 | failed | 3 | Environment: verifying |
| ATT-764-7 | failed | 4 | Environment: ready |
| ATT-764-8 | queued | 88 | Compliance |
| ATT-776-1 | finished/completed | 91 | Completed |
| ATT-777-1 | failed | 9 | Environment: ready |
| ATT-777-2 | failed | 4 | Validate |
| ATT-777-3 | failed | 65 | Environment: ready |
| ATT-777-4 | finished/exhausted | 40 | Needs attention |
| ATT-777-5 | finished/exhausted | 30 | Needs attention |
| ATT-777-6 | failed | 38 | Environment: blocked |
| ATT-777-7 | running | 101 | Environment: ready |
| ATT-842-1 | failed | 12 | Environment: ready |
| ATT-842-2 | finished/exhausted | 103 | Needs attention |
| ATT-842-3 | parked | 61 | Compliance |
| ATT-893-1 | finished/exhausted | 155 | Needs attention |
| ATT-893-2 | finished/exhausted | 131 | Needs attention |
| ATT-893-3 | finished/exhausted | 125 | Needs attention |
| ATT-920-1 | failed | 7 | Implement |
| ATT-920-2 | finished/exhausted | 188 | Needs attention |
| ATT-920-3 | running | 276 | Validate |
| CONFIG-1790255865894-1 | finished/completed | 1 | Passed |

Local primary evidence paths: `~/.rocky/runs/<id>/run.json`, `journal.jsonl`, and `snapshot/workflow.json`. Raw journals/transcripts can contain private task data and are not bundled here.

## 8. Reproducible evidence anchors

| Run and journal sequence | Observation | Interpretation limit |
| --- | --- | --- |
| ATT-776-1, seq 3–7 and final $end | Human clarified current design is acceptable; delivery changes to linear-comment; terminal completed | No code/PR delivery; not unattended coding acceptance |
| ATT-1079-5, seq 101, 123, 126–128 | CI pass at 3bb703f; UI plan includes real commissioning; fixture responses name missing CC100/MQTT/identity/release; exhausted | A repository-consolidation task acquired broader hardware checks; those requirements need explicit scope review |
| ATT-1098-4, seq 379, 401, 404–406 | CI pass at 968f23b; initialized server cannot supply fresh-install states; reader/card/device fixtures absent; exhausted | Firmware/device verification cannot be inferred from web screenshots |
| ATT-920-3, seq 438–441 | CI passed at 0017857; subsequent review/fixer says current-head CI evidence not retained/supplied | Direct evidence mismatch; not proof every review concern is invalid |
| ATT-893-3, seq 464, 475, 477–479 | Passing CI; fixer cannot safely support undeclared plugin pages; historical complaint remains; draft/exhausted | Genuine requirement/architecture disagreement needs a decision |
| ATT-764-6 and ATT-764-7 headers | Previously verified service unavailable / UI endpoint unreachable | PR #53 changes replay/readiness; latest ATT-764-8 remains incomplete |
| ATT-777-3 and ATT-777-6 headers | ENOSPC and unfinished Codex bash tool work | Infrastructure/tool lifecycle failures, not proof of wrong product code |
| ATT-1079-4 header | Job log download failed | Missing diagnostics must not erase known failed-job evidence |
| ATT-1098-1/-2 headers | Linear payload/session mismatch and missing ctx.post adapter | Integration/replay errors can strand non-coding delivery work |

The examples identify observed blockers, not mutually exclusive root-cause labels for all 40 runs. A run can encounter several failures across runtime upgrades and retries.

## 9. Target-repository delivery state

| PR | Branch | State | Head |
| --- | --- | --- | --- |
| [#1880](https://github.com/Attraccess/Attraccess/pull/1880) | att-764 | OPEN / draft | 372d52b39599 |
| [#1882](https://github.com/Attraccess/Attraccess/pull/1882) | att-893 | OPEN / draft | 1bffe2c6b4f1 |
| [#1883](https://github.com/Attraccess/Attraccess/pull/1883) | att-777 | OPEN / draft | d9b10ef6fc13 |
| [#1884](https://github.com/Attraccess/Attraccess/pull/1884) | att-1079 | OPEN / draft | 3bb703f2e863 |
| [#1885](https://github.com/Attraccess/Attraccess/pull/1885) | att-842 | OPEN / draft | 01999b169b17 |
| [#1886](https://github.com/Attraccess/Attraccess/pull/1886) | rocky-att-1098 | OPEN / draft | 968f23bfa7c8 |
| [#1887](https://github.com/Attraccess/Attraccess/pull/1887) | att-1089 | OPEN / draft | 6cebed31fe12 |
| [#1888](https://github.com/Attraccess/Attraccess/pull/1888) | att-920 | OPEN / draft | 0017857df47d |

These eight PR states were read from GitHub. No merge or review was requested by this audit. PR presence demonstrates useful implementation output, not verified task completion.

## 10. Inspection method and limitations

Used git identity/status and tracked-file inventory; `gh pr list/view/diff` for Rocky and target PRs; `rocky status` and listener inspection; direct read-only JSON/JSONL parsing of retained headers, snapshots and selected journal results; source reading at the listed boundaries; official-source web research in the companion report. No agent retries, service starts, profile edits, repository-code fixes, or outgoing issue messages were performed.

The stopped daemon prevents live API projection checks. Header state can be stale and installed version 0.2.0 alone cannot identify a build. Earlier task memory was used to locate failure history, then current source/PR/disk evidence was reread. Main evidence limits: retained history only, mixed runtime versions, repeated issues, no controlled model comparison, no independent source-line audit, and no fresh end-to-end coding trial. These limits motivate a predeclared benchmark for the successor.

