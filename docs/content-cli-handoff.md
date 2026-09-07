# Content CLI Integration

Scoped NG-607/608 implementation lives in `packages/daemon/src/content/seed.ts` and `packages/cli/src/content-commands.ts`, with focused adjacent specs. This worker did not edit the command table, package manifests, daemon exports, loader, Workflow, or Harness adapters.

## Export and Registration

The ingress/packaging owner must export these symbols from `@rocky/daemon` (its `src/index.ts`): `Inspection`, `inspectionPrompt`, `inspectionTools`, `Conventions`, `conventionsPrompt`, `conventionsTools`, `readAgentDocuments`, `selectStates`, `assertUnconfigured`, `seedContent`, `inspectAndSeed`, and types `AgentDocument`, `TeamState`, `SeedOptions`. `Inspection` is both a Zod schema and its inferred type.

Import `initContent` and `upgradeContent` from `./content-commands.js` in CLI registration. Remove the corresponding stub entries from `commands.ts` when adding the real Commander actions. Register `init` without a force option, and `upgrade --harness <claude-code|opencode>` with CLI-only default `claude-code`. Pass `process.cwd()` as `repo`.

`initContent({ repo, seed })` refuses any existing `.rocky` entry before invoking the foreground callback. Wire `seed(repo)` to `inspectAndSeed` below. It returns the installed `.rocky` path; print that the files are uncommitted and ready for review.

`upgradeContent({ repo, shippedDir, harness, paths?, env? })` inherits terminal I/O and returns `{ code: number | null, signal: NodeJS.Signals | null }`. The CLI action must set `process.exitCode` to the child's code, or re-raise the child's signal against the CLI process after the promise resolves. Do not turn an interrupted session into success. Print thrown named-fix errors through the existing CLI error path. Native login diagnostics remain on the inherited terminal, and a failing session never falls back to another Harness/account.

## Assets

Package the complete `packages/daemon/content/.rocky/` tree, including hidden-directory entries, and provide its absolute installed path as `shippedDir`. Compute it relative to the installed daemon package, not `cwd`, and smoke-test the packed artifact. The source test uses that actual tree; no runtime downloads are implemented.

Treat the installed default as read-only. Upgrade supplies the path in its prompt and denies native edits to that tree. The session has no shell tool, so comparison/editing stays within native file tools. Test package symlinks/path canonicalization and read-only permissions in the packed-install gate; the command currently requires a real directory rather than a symlink at the supplied path.

## Inspection and Seeding

`inspectAndSeed({ repo, shippedDir, inspect, resolveTeamStates?, distill?, validate })` is the foreground composition, not a Run. Its framework callbacks are intentionally required where an engine/loader is needed:

- `inspect(repo): Promise<unknown>` must use the existing foreground Harness execution seam, `inspectionPrompt`, `inspectionTools` (`read` only), no MCP, and the `Inspection` schema. Inspect metadata/scripts/code for commands and UI only. The helper parses the output before staging.
- `resolveTeamStates(repo)` returns actual `{ name, type, position }[]`, resolving the routing label to a team if possible. Return `undefined` when no team can be identified; genuine service errors propagate. The fallback emits conventional names plus a verification comment inside Config.
- `distill(documents)` receives only root `CLAUDE.md`, `AGENTS.md`, and `CONTRIBUTING.md` text. Use `conventionsPrompt`, `Conventions`, zero Capabilities (`conventionsTools`) and no MCP. This separate call must have no repository browsing tools. No documents means no call or generated rules; a docs-bearing repo without a distiller fails rather than silently dropping its rules. Symlinked documents are excluded.
- `validate(stagedRockyDir)` must use the framework loader to import/validate the generated Workflow and Trigger table, and reject invalid output. Do not wire a no-op or substitute a marker regex. No production loader was available within this worker's ownership.

`seedContent({ repo, shippedDir, inspection, teamStates?, distill?, validate })` is the shared lower-level helper for Onboarding. It validates Inspection again, copies assets into a uniquely owned sibling staging directory, fills only Config, optionally adds Playwright, distils explicit docs, then invokes the loader callback before installation. It returns the installed `.rocky` path.

The Onboarding owner must compose Agent calls and filesystem effects at the existing journaled boundaries. `seedContent` itself is intentionally non-journaled and refuses a previously installed tree; Run replay/adoption belongs to the Onboarding orchestration, not an overwrite option. If distillation is already a settled Agent Step, pass a callback returning its recorded result while still enforcing the document-only provenance contract.

State selection sorts by position, then name for deterministic ties: `started` is the first started-type state; `review` prefers a started-type name containing `review` (case-insensitive), otherwise the started selection; `done` is the first completed-type state. An identified team without started/completed states fails with a fix.

The whole Config block is serialized from the brief's agreed constants. Caps, model defaults, readiness and log limits remain the agreed defaults; updating the shipped Config contract requires updating this serializer in the same change. Agent/schema/MCP bytes are otherwise copied intact, except the optional Playwright entry and `rules/conventions.md`.

Staging stays outside `.rocky`; failed attempts clean only their uniquely owned directory. A hard process crash may leave an orphan `.rocky-seed-*` sibling, which retries ignore. Installation uses the host `mv -n` no-clobber operation, with the repository as destination parent, so a colliding entry is not replaced or used as a nesting destination. This requires the supported Unix host's no-clobber `mv`; verify simultaneous-install behavior on each supported host in integration. No git command is used by production seeding.

## Upgrade Policy

Configured command/environment/storage resolution reuses `readInstanceConfig`, `expandHarness`, and `harnessAuthEnv`. No credentials are inspected and no Run storage is created. `resolveHarness` and `launch` are optional external-boundary test seams; production defaults are implemented.

Claude Code starts interactively in `default` permission mode, with only Read/Glob/Grep/Edit/Write, explicit edit/write ask rules, hooks disabled, and an empty strict MCP configuration. OpenCode starts its TUI with an ephemeral `rocky-upgrade` primary-agent policy: edits ask, shipped-tree edits deny, shell/subagents deny. `--pure` disables external plugins; `OPENCODE_DISABLE_PROJECT_CONFIG=true` avoids project config discovery writing `.opencode` files before consent. Account/storage environment is retained; the inline session policy supersedes automatic-edit permissions. Neither command uses headless, bypass, or auto-accept flags.

Native reference points checked during implementation: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode permissions](https://opencode.ai/docs/permissions/), and OpenCode's config loader for project-discovery startup writes. Unsupported native flags must fail rather than retry without safety settings.

## Verification and Gates

Focused specs exercise staging-before-validation, retry/cleanup, explicit-doc provenance, state selection, Config byte boundaries against shipped assets, existing-entry refusals (including collisions during validation), dirty working copy/index preservation, native launch arguments, account/storage resolution, pre-/post-consent abort semantics at the process seam, child exit/signal results, and missing binaries. The process tests launch only local Node fixtures, not agent sessions or network services.

Required integration gates still owned by the combined delivery:

1. Wire the foreground inspection/distillation engine and production loader; exercise `rocky init` through actual Commander registration against packed assets.
2. In both supported native Harness versions, show both trees, reject an edit, abort before consent byte-identically, accept an edit, then abort while retaining that edit uncommitted. Include dirty/index state and check that native startup creates no repository files.
3. Verify policy precedence against permissive user config, plugin/project config, managed policy, native storage paths, and shipped-asset aliases. Native hooks/plugins/startup effects are not proved by a mocked launch test.
4. Verify real terminal Ctrl-C and SIGTERM behavior, native login failures, and CLI exit/signal propagation. Unit tests cover child outcomes; they do not prove terminal process-group behavior.
5. The main Onboarding owner must prove the journaled seed PR/adoption/CI journey; these foreground helpers do not replace it.
