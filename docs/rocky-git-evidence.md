# Rocky Git Evidence

Research snapshot: **2026-09-07, 07:46-07:52 UTC**. Scope: this Git repository and `JappyMondo/rocky` on GitHub only. No Linear queries; issue identifiers below come from repo text or GitHub PRs, not verified ticket status. All source paths/line numbers refer to remote `main` at **`15124540349cbb48db81933c4abfb9aa3560553d`**, unless another revision is specified.

**Bottom Line**
**Assessment:** Rocky has a substantial, tested platform foundation on GitHub, but not a connected ticket-to-merge product. Neither "only design exists" nor "the development platform works" is supported. Local `main` is stale; the attractive UI and complete-looking Workflow on prototype branches are explicitly throwaway, not the implemented product. A completion percentage would conflate design, isolated subsystems and end-to-end functionality.

**Verified State**

| Surface | Observed fact |
| --- | --- |
| Local `main` and `origin/main` | Both still `24365162c09d0b3410f1c7f56038b75e71d29e65`, committed **2026-09-01 08:34:27 UTC**. Exactly **24 reachable commits**, all documentation/license/ignore changes; **9 tracked files**, including five ADRs. No apps, packages, manifest, tests or CI at this revision. |
| Live remote `main` | `1512454`, committed **2026-09-04 18:36:54 UTC**, independently confirmed by `git ls-remote --symref origin` and `gh api repos/JappyMondo/rocky/commits/main`. **35 reachable commits**, **155 tracked files**, **44 test files**, four buildable projects. Local is **0 ahead / 11 behind** this revision. [Commit][main-commit] / [tree][main-tree]. |
| Branches | **18 live remote heads**: `main`, ten PR branches below, two prototypes, five research branches. **9 local branches**: stale `main`, both prototypes, all five remote research branches, and one local-only research draft. Local tracking refs cover only nine remote branches, excluding symbolic `origin/HEAD`. One registered worktree. |
| Pull requests | **10 total: 9 merged, 1 closed unmerged, 0 open, 0 draft.** Merged work: seven code PRs, one CI PR, one documentation PR. All target `main`; all ten head branches still exist. |
| Releases | **0 remote tags, 0 GitHub releases** observed. Repository created **2026-08-24 09:14:38 UTC**; latest reported push **2026-09-04 18:36:55 UTC**. This does not establish npm registry publication status. |

`git log --all` includes many local `refs/t3/checkpoints/*` snapshots. They are not product commits or GitHub branches and are excluded from the counts above. Missing remote objects were fetched by explicit SHA with `--no-tags --no-write-fetch-head`; no branch, tracking ref or working-tree revision was moved.

**Merged Inventory**

| Area | What exists in source | Boundary on the claim |
| --- | --- | --- |
| Workspace | Nx 23.1.1, pnpm 10.33.1, Node >=24, TypeScript 6, Fastify daemon, React 19/Vite web shell, `rocky` CLI, `@rocky/sdk`; lockfile, lint/typecheck/build/test wiring. [Root manifest][manifest], [README:54-77][development]. | Buildable workspace; one-package distribution is not wired. All package versions are `0.0.0`. |
| Daemon and CLI | Foreground/detached start, status/version handshake, stop/restart, rotating redacted logs, doctor, service-unit file install/uninstall; setup and repo add/list/remove are implemented. [cli.ts:172-467][cli], [run-daemon.ts:101-240][lifecycle]. | Service commands write files and print load/unload instructions; they do not themselves activate a service. Four commands still deliberately fail as stubs: `init`, `upgrade`, `mcp login`, `trigger` ([commands.ts:23-50][stubs]). |
| Instance config | Typed `~/.rocky/config.json` and credentials; atomic writes, 0600 credentials, hot reload except socket binding, secret redaction, label/team routing and Repo groups. [config/store.ts:1-149][store], [config/schema.ts:43-247][config]. | Routing returns a destination or Refusal text; posting that Refusal and admitting a Run are not connected. MCP credentials remain an opaque storage slot, not an OAuth implementation. |
| External-session plumbing | Setup manifest/OAuth wizard, token refresh, raw-body webhook verification, activity/comment/attachment/upload client, boot/hourly instance-id self-ping. [setup/wizard.ts:94-312][setup], [linear/webhook.ts:115-185][webhook], [linear/client.ts:181-396][linear-client]. | Source and tests exist, but no live external install was exercised in this research. Production webhook handling defaults to a no-op; connectivity is not delegation-to-Run execution. |
| Repos/workspaces | Own bare clones, eager CLI clone, grouped worktrees, existing-branch adoption, worktree identity, per-repo mutex, fast-forward-only human-push adoption, workspace sweep. [repos/workspace.ts:89-220][workspace], [repos/adopt.ts:73-169][adopt], [repos/sweep.ts:15-95][sweep]. | Real Git-backed library behavior, but no production Run caller. `followConfigReloads` is exported/tested but not called by daemon boot; cleanup requires its caller to supply correct live-Run/pushed-branch guarantees. |
| Journal/replay | File-backed headers, versioned JSONL, running/settled writes, recorded-result/error replay, parking, divergence/crash-loop guards, stage/boot/time fields and `failed`/`steer` attempt schemas. [run/journal.ts:66-118][journal], [run/replay.ts:192-317][replay], [run/header.ts:120-293][header]. | A real isolated engine, not yet a working Run service. `runBoot` and `readRunIndex` have no production caller. `BootContext` explicitly leaves real `ctx` wiring to later work (replay.ts:81). |
| SDK/Harnesses | Frozen Trigger descriptors, Workflow/SCM types and `z`; purity guard. Harness contract, Claude Capability-to-tool mapping and standalone auth probes for both CLIs. [sdk/triggers.ts:1-42][triggers], [harness/types.ts:1-55][harness-types], [harness/claude-code.ts:1-11][claude]. | **Neither runnable Harness adapter is implemented.** No Agent `run`/`resume`, stream parser, Transcript capture or per-Step MCP renderer was found. Auth probes are not Agent execution. |
| Visible web app | A heading, loading/connected/unreachable health text, conditional endpoint warning; one `/api/health` fetch on mount. [app.tsx:25-83][web]. | **Health shell only**, not Inbox, Run detail, diff viewer, screenshots, Checkpoint interaction, settings or streaming Transcript. Its five jsdom tests mock `fetch`. |

**Integration Gaps**
Observed absent from the current production path: Workflow import/validation and snapshotting; Run admission/numbering/concurrency and recovery scheduling; a real `WorkflowContext`; Agent execution/structured output/Steer delivery; Checkpoint Answer arbitration; SCM Preflight, PR creation, CI polling/fixing and merge adapters; default Workflow/Agent/Rule content and Onboarding; Run/artifact APIs and the selected UI; retention execution and publish packaging.

The key negative evidence is explicit, not inferred from file names alone: [server.ts:149-152][server] installs `onEvent: options.onAgentSessionEvent ?? (() => undefined)`, and [run-daemon.ts:152-165][lifecycle] supplies no handler. Production-symbol searches find `runBoot`, `readRunIndex`, `createWorkspace`, `adoptRemoteMoves` and `sweep` only at declarations/exports or within their own libraries, not in daemon orchestration. The only authored HTTP routes are health, ping, OAuth callback, webhook and shutdown, plus static serving. There is no production `.rocky/` tree. SCM's eight operations are **interfaces only** ([sdk/ctx.ts:73-103][ctx]).

**Assessment:** the remaining work is both missing features and integration of already-merged modules. Do not recount the Journal, Git worktree or config implementations as wholly unbuilt, but do not count their intended user journeys as done either.

**PR History**
Times below are GitHub creation and merge/closure timestamps in **UTC**, not commit author dates. Short SHAs identify immutable heads and landed commits; PR links provide full metadata and commit lists.

| PR / Scope | Created UTC | Merged UTC, except #1 | Head -> Landed SHA |
| --- | --- | --- | --- |
| [#1][pr1] NG-515 retired NestJS/server scaffold | 2026-08-28 11:12:06 | **Closed unmerged 2026-09-01 11:34:22** | `2b25f22` -> none |
| [#2][pr2] NG-515 replacement daemon/CLI/SDK/web scaffold | 2026-09-01 11:33:18 | 2026-09-01 12:12:57 | `d4586d2` -> `17bfada` |
| [#3][pr3] NG-594 config/credentials | 2026-09-02 12:26:34 | 2026-09-02 12:42:13 | `f892490` -> `d34155d` |
| [#4][pr4] NG-562 CI hardening | 2026-09-02 12:54:28 | 2026-09-02 13:17:00 | `563f749` -> `861998d` |
| [#5][pr5] NG-600 setup/webhook/self-ping | 2026-09-02 13:38:42 | 2026-09-02 13:49:13 | `b586506` -> `658e135` |
| [#6][pr6] NG-595 daemon lifecycle/CLI | 2026-09-02 13:42:56 | 2026-09-04 18:36:55 | `cc7c36b` -> `1512454` |
| [#7][pr7] NG-521 repos/workspaces | 2026-09-02 13:46:07 | 2026-09-04 12:31:01 | `cac18af` -> `361a3d9` |
| [#8][pr8] NG-630 attempt-kind documentation | 2026-09-02 13:58:54 | 2026-09-02 14:02:40 | `2b34b19` -> `021f58a` |
| [#9][pr9] NG-596 Journal/replay | 2026-09-02 14:05:58 | 2026-09-02 14:13:50 | `563653c` -> `64ac0cd` |
| [#10][pr10] NG-525 Harness contract, reduced scope | 2026-09-03 15:36:12 | 2026-09-04 08:27:36 | `5f5a9bc` -> `653694f` |

The exact live PR branch names, in PR-number order:

```text
ng-515-scaffold-the-nx-monorepo-nestjs-server-react-spa-and-deploy
ng-515-scaffold-the-workspace-daemon-rocky-cli-rockysdk-and-the-web
ng-594-instance-config-and-credentials-rocky-hot-reload-and
ng-562-harden-ci-affected-only-runs-coverage-reporting-and-required
ng-600-rocky-setup-the-per-developer-oauth-app-the-webhook-and-the
ng-595-daemon-lifecycle-and-the-rocky-cli-start-stop-doctor-and
ng-521-repos-and-workspaces-rockys-own-clones-per-run-worktrees-the
ng-630-doc-reconciliation-name-the-journal-attempt-kinds-failed-and
ng-596-journal-and-replay-journaljsonl-two-phase-steps-and
ng-525-harness-adapter-interface-and-the-claude-code-adapter
```

#2 and #3 landed with merge commits; #4-#10 were squashed. Consequently, unique commit SHAs on those retained branches do **not** mean their implementation is still unmerged. `git diff <head> <landed>` is empty for **all nine merged PRs**: each retained head has the same tree as its landed commit. No additional unmerged implementation beyond the retired scaffold and throwaway prototypes was found among the inspected branch tips.

**Historical Work**
The pivot is visible in Git: [README rewrite `2d72bf4`](https://github.com/JappyMondo/rocky/commit/2d72bf4c326d2ab96fd2fd92a60f9b055d76dc81) on **2026-08-28 16:28:33 UTC**, then [glossary replacement `ec73b1a`](https://github.com/JappyMondo/rocky/commit/ec73b1a3124a8543d696c5fedcab594c41dfaa59) at **19:10:28 UTC**. The latter removes the reviewer vocabulary, not a working review engine. No whole-file deletions appear in reachable product-branch history; this was not deletion of a previously merged application.

Original NG-515 is **three unmerged commits** (`32019bf`, `3df9910`, `2b25f22`, all 2026-08-28), containing NestJS/Fastify health/Swagger/static serving, four `ROCKY_*` deploy variables, `/data` assumptions, tests and a generated Nx welcome UI. There is no implemented reviewer, learning loop, multi-user system or database there, and no Dockerfile. [Historical README:34-73][old-readme]. The [closure comment][closure] explicitly says #2 reused CI/lint/format setup and rebuilt the product shape. Its passing historical CI does not make it current platform implementation.

| Other branch | Tip / Commit time UTC | Inventory and disposition |
| --- | --- | --- |
| `prototype/ng-572-workflow-authoring` | `1f1fde8`, 2026-08-28 18:54:40 | One unique commit; `.rocky/` example, SDK sketch, fake world and replay demo. Explicitly throwaway ([PROTOTYPE.md:3-25][workflow-prototype]). No PR. |
| `prototype/ng-573-local-web-ui` | `1f2a5dc`, 2026-08-28 20:46:53 | Three unique commits; four UI variants and `rocky-ui-prototype.html`. **Inbox A with C's annotated diff** selected; TUI excluded. No backend/persisted decisions; screenshots are inline SVG ([PROTOTYPE.md:6-25,105-110][ui-prototype]). No PR. |
| `research/scm-integration-surfaces` | `53509f1`, 2026-08-24 09:45:31 | One Markdown addition, [research/scm-integration-surfaces.md][research-scm]; retired reviewer integration assumptions. No PR. |
| `research/cli-harnesses-headless-docker` | `a22b3a8`, 2026-08-25 08:24:40 | One Markdown addition, [research/cli-harnesses-headless-docker.md][research-cli]; container-era investigation, not an adapter. No PR. |
| `research/linear-agent-session-api` | `d1f3472`, 2026-08-28 16:33:15 | One Markdown addition, [research/linear-agent-session-api.md][research-session]; API research only. No PR. |
| `research/platform-merge-ci-surfaces` | `e917426`, 2026-08-28 16:38:08 | One Markdown addition, [research/platform-merge-ci-surfaces.md][research-merge]; no SCM implementation. No PR. |
| `research/sandcastle-capability-audit` | `623c2a6`, 2026-08-28 16:33:06 | One Markdown addition, [research/sandcastle-capability-audit.md][research-sandcastle]; its wrapped-Sandcastle premise was superseded by ADR 0001. No PR. |
| `research/cli-harness-docker` (**local only**) | `33e34f2`, 2026-08-28 21:50:18 | One Markdown addition, `research/cli-harness-docker.md`; commit explicitly parks the superseded NG-481 draft. No matching remote head/PR. |

All eight are unmerged; their content is absent from remote `main`. Prototype evidence must be labeled **designed/prototyped**, not shown as live product screenshots. NG-572 also predates later decisions: separate `config.ts`, Agent frontmatter, planner `touchesUi`, and optional Complaint file/no id remain there ([agents/README.md:3-14][old-agents], [schemas.ts:16-40][old-schemas]), contrary to current `CONTEXT.md:11-12,20,30-35`.

**Design Alignment**
All five ADRs were read on both local and remote revisions. ADRs 0001-0004 and `CONTEXT.md` are unchanged between them; ADR 0005 has the **2026-09-02** attempt-kind amendment.

| ADR | Decision | Implementation alignment |
| --- | --- | --- |
| [0001][adr1], 2026-08-31 | Own adapters, no Sandcastle, exactly two v1 Harnesses; third requires code. | No Sandcastle dependency; own Git primitives and adapter contract. Runnable adapters missing. |
| [0002][adr2], 2026-09-01 | Trigger builders; manual follow-up instead of PR-review wake; import outside Run. | Builders implemented; loader/routing/execution/manual firing absent. |
| [0003][adr3], 2026-09-01 | Vendor complete default `.rocky/`; SDK types/builders only; conversational upgrade. | SDK purity implemented/tested. Default content, Onboarding, init and upgrade absent. |
| [0004][adr4], 2026-09-01 | Rocky-owned, URL-keyed MCP OAuth and static header handoff. | Credential slot and Harness types only; no login/refresh/rendering/Preflight implementation. |
| [0005][adr5], 2026-09-01; amended 2026-09-02 | Guaranteed verbatim Steer delivery; remove `ctx.interruptions`; `failed`/`steer` attempts. | Attempt union matches; old API absent. Delivery/session continuation still unbuilt. |

**Documentation Conflicts**
Current prose sources: [README.md][readme], [CONTEXT.md][context], [docs/public-endpoint.md][endpoint-guide], and the five ADRs above.

- **Status overstates and understates at once.** README:102 still says "Pre-implementation", despite merged subsystems. README:7,26,32-36 describes the complete pipeline, shipped defaults, tested Harnesses and rich UI in present tense, despite the missing integration above. README:81's "most" commands stubbed is also stale: only four command signatures remain in the stub table.
- **Harness configuration contradicts ADR 0001.** README:32 allows other configurable, untested Harnesses; ADR 0001:5 and CONTEXT:23 require adapters. Config validation actually rejects other names (schema.ts:193-199). [PR #10][pr10] explicitly deferred runnable Claude work to NG-643 and removed Claude from the allowed list; [later `bbb7e4a`](https://github.com/JappyMondo/rocky/commit/bbb7e4aca345d11f24933ae8c04e7c129bd9d110), landed through #6, restores only the config allowlist/test. It does **not** supply a runnable adapter. Neither the PR wording "opencode ... available" nor the symbol `SHIPPED_HARNESSES` proves one exists.
- **Outside-Run loading rule is stale.** README:19 calls `mcp.json` the only file read outside a Run; ADR 0002:5 explicitly permits importing `workflow.ts` outside a Run to discover Triggers. CONTEXT:13 agrees with the ADR.
- **Journal's "only durable truth" has an undocumented exception.** CONTEXT:16 and config/paths.ts:53-55 call the header a cache; [run/header.ts:9-12][header] says issue snapshot and branch live **only** in `run.json`, making a missing header unrecoverable. Do not promise reconstruction from Journal alone.
- **SDK and replay surfaces are not yet aligned.** ADR 0005:7 and replay.ts:81-92 include non-journaled `stage()`, but exported `WorkflowContext` (sdk/ctx.ts:132-174) lacks it. The built replay context is not the SDK Workflow context.
- **Polling assurances describe future behavior.** public-endpoint.md:125-137, cli.ts:283 and app.tsx:66 promise continued Run progress when webhooks fail; no production recovery/polling loop exists. [PR #5][pr5] itself records this as deferred NG-629. The UI also reads health only once, so the current warning is not a live outage/recovery indicator.
- **Public endpoint instructions conflict with implemented doctor.** The guide permits only webhook/ping (public-endpoint.md:26-41), but [doctor.ts:65-88][doctor] requests `/api/health` through the public URL and accepts HTTP success without checking instance identity. A correctly path-restricted tunnel therefore fails doctor; the real monitor uses `/api/ping` plus identity comparison.
- **One documented tunnel recipe violates the guide's own security boundary.** public-endpoint.md:33-36 says never expose the unauthenticated UI, while its ngrok command and warning at :84-91 explicitly expose the whole daemon. This includes unauthenticated `/api/shutdown` (server.ts:177-194). The endpoint-move prose also contradicts itself: :19-20 says recreate the app, but :146-149 allows an admin settings edit; README:79 simply says it cannot change. These are internal contradictions, not externally revalidated API claims.
- **Distribution is still aspirational.** README:58 calls `npx rocky` the distribution, but [cli/package.json:26-28][cli-package] depends on private [daemon/package.json:7,22-27][daemon-package] through `workspace:*`; no publishing workflow exists. [PR #2's comment][packaging] explicitly defers one-package publication to NG-617. No GitHub release/tag was found.
- **Retired tooling survives.** [.vscode/launch.json:7-18][debug] still launches `nx serve server` and targets `apps/server/dist`, neither of which exists on current `main`. README:77 names required check `CI`; the actual protected context and aggregate job are lowercase `ci`.

**Tests And CI**
Latest `main` [CI run 33906849592][ci-run], for exact SHA `1512454`, was created **2026-09-04 18:36:58 UTC** and completed successfully **18:38:21 UTC**. Its [check job log][ci-job] reports **645 passing tests across 44 files**, with no skipped tests in the reported totals:

| Project | Tracked files / Test files | Passing tests | Statements / Branches / Functions / Lines |
| --- | --- | --- | --- |
| `packages/daemon` | 81 / 33 | 498 | 96.25 / 88.24 / 96.69 / 96.52% |
| `packages/cli` | 27 / 9 | 136 | 90.46 / 83.33 / 87.93 / 90.90% |
| `packages/sdk` | 10 / 1 | 6 | 100 / 100 / 100 / 100% |
| `apps/web` | 14 / 1 | 5 | 100 / 82.35 / 100 / 100% |

The workflow runs frozen-lockfile install, formatting, build/typecheck/lint, tests with per-project coverage floors, audit at high severity and PR dependency review. PRs use `nx affected`; `main` targets all four projects. There are two documented audit waivers (README:75, package.json:49-53). The latest run's `check`, `audit`, `ci` passed; dependency review was correctly skipped on a push. Coverage measures existing code, not missing product features; the SDK's 100% statements is **3/3**, and the web shell's is **13/13**. Repo/Git and daemon-process tests exercise real local resources; external APIs and the web health response are mocked. No real-agent or full ticket-to-merge test was found.

Live GitHub protection API: required context **`ci`**, strict up-to-date checks, one approving review, stale-review dismissal, signed commits, linear history; **admin enforcement is off**. Repo settings currently allow squash merges only. Source: `gh api repos/JappyMondo/rocky/branches/main/protection` and `gh api repos/JappyMondo/rocky`. This is current policy, not proof every historic merge had a review. Prose is excluded from Prettier ([.prettierignore:22-26][format-ignore]); CI does not check these semantic documentation contradictions.

**Verification Limits**
Read all local tracked files, current remote tree/manifests/ADRs, implementation modules and relevant tests, all branch-tip histories/deltas and all ten PR descriptions; inspected relevant PR comments/commits, live refs, protection and CI logs. File contents were inspected from Git objects without switching branches. No dependencies installed, tests rerun locally, daemon launched, browser opened, package registry queried, or real Harness/SCM/Linear flow exercised. Historical research's external API claims were not revalidated. Ignored/uncommitted files in other clones and unreachable/deleted remote refs are not covered; local tool checkpoint refs are not releases. The only authored workspace artifact is this note.

[main-commit]: https://github.com/JappyMondo/rocky/commit/15124540349cbb48db81933c4abfb9aa3560553d
[main-tree]: https://github.com/JappyMondo/rocky/tree/15124540349cbb48db81933c4abfb9aa3560553d
[manifest]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/package.json#L1-L55
[development]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/README.md#L54-L77
[cli]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/cli/src/cli.ts#L172-L467
[lifecycle]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/lifecycle/run-daemon.ts#L101-L240
[stubs]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/cli/src/commands.ts#L23-L50
[store]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/config/store.ts#L1-L149
[config]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/config/schema.ts#L43-L247
[setup]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/cli/src/setup/wizard.ts#L94-L312
[webhook]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/linear/webhook.ts#L115-L185
[linear-client]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/linear/client.ts#L181-L396
[workspace]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/repos/workspace.ts#L89-L220
[adopt]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/repos/adopt.ts#L73-L169
[sweep]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/repos/sweep.ts#L15-L95
[journal]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/run/journal.ts#L66-L118
[replay]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/run/replay.ts#L192-L317
[header]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/run/header.ts
[triggers]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/sdk/src/triggers.ts#L1-L42
[harness-types]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/harness/types.ts#L1-L55
[claude]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/harness/claude-code.ts#L1-L11
[web]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/apps/web/src/app/app.tsx#L25-L83
[server]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/server.ts#L130-L194
[ctx]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/sdk/src/ctx.ts#L73-L174
[doctor]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/src/doctor/doctor.ts#L65-L88
[cli-package]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/cli/package.json#L26-L28
[daemon-package]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/packages/daemon/package.json#L1-L27
[debug]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/.vscode/launch.json#L7-L18
[format-ignore]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/.prettierignore#L22-L26
[old-readme]: https://github.com/JappyMondo/rocky/blob/2b25f22317775685dc52d8ad19d742efddcc664f/README.md#L34-L73
[closure]: https://github.com/JappyMondo/rocky/pull/1#issuecomment-5493296367
[packaging]: https://github.com/JappyMondo/rocky/pull/2#issuecomment-5493325124
[workflow-prototype]: https://github.com/JappyMondo/rocky/blob/1f1fde8719525d063bbc11daf002cccb4817526a/PROTOTYPE.md#L3-L25
[ui-prototype]: https://github.com/JappyMondo/rocky/blob/1f2a5dc9f522b0b00fde032bba23a422b0d94ff3/PROTOTYPE.md#L6-L110
[old-agents]: https://github.com/JappyMondo/rocky/blob/1f1fde8719525d063bbc11daf002cccb4817526a/.rocky/agents/README.md#L3-L14
[old-schemas]: https://github.com/JappyMondo/rocky/blob/1f1fde8719525d063bbc11daf002cccb4817526a/.rocky/schemas.ts#L16-L40
[research-scm]: https://github.com/JappyMondo/rocky/blob/53509f1384e5dd94bb0eee15f4cdbde1c8d962c9/research/scm-integration-surfaces.md
[research-cli]: https://github.com/JappyMondo/rocky/blob/a22b3a88723330bc1e6ab618c7eb5fb40f15f664/research/cli-harnesses-headless-docker.md
[research-session]: https://github.com/JappyMondo/rocky/blob/d1f347282b1ae18066ed2e54365466e69b65e4e3/research/linear-agent-session-api.md
[research-merge]: https://github.com/JappyMondo/rocky/blob/e91742680ede7736c89f719ed52ebfe75c6843a2/research/platform-merge-ci-surfaces.md
[research-sandcastle]: https://github.com/JappyMondo/rocky/blob/623c2a65253df4de845f79984cd26ead44e96236/research/sandcastle-capability-audit.md
[readme]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/README.md
[context]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/CONTEXT.md
[endpoint-guide]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/public-endpoint.md
[adr1]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/adr/0001-own-harness-adapters-no-sandcastle.md#L3-L5
[adr2]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/adr/0002-triggers-not-first-party-review-wake.md#L3-L5
[adr3]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/adr/0003-vendored-rocky-upgraded-by-conversation.md#L3-L5
[adr4]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/adr/0004-rocky-owned-mcp-auth-static-headers.md#L3-L5
[adr5]: https://github.com/JappyMondo/rocky/blob/15124540349cbb48db81933c4abfb9aa3560553d/docs/adr/0005-guaranteed-steer-delivery.md#L3-L9
[pr1]: https://github.com/JappyMondo/rocky/pull/1
[pr2]: https://github.com/JappyMondo/rocky/pull/2
[pr3]: https://github.com/JappyMondo/rocky/pull/3
[pr4]: https://github.com/JappyMondo/rocky/pull/4
[pr5]: https://github.com/JappyMondo/rocky/pull/5
[pr6]: https://github.com/JappyMondo/rocky/pull/6
[pr7]: https://github.com/JappyMondo/rocky/pull/7
[pr8]: https://github.com/JappyMondo/rocky/pull/8
[pr9]: https://github.com/JappyMondo/rocky/pull/9
[pr10]: https://github.com/JappyMondo/rocky/pull/10
[ci-run]: https://github.com/JappyMondo/rocky/actions/runs/33906849592
[ci-job]: https://github.com/JappyMondo/rocky/actions/runs/33906849592/job/101133676048
