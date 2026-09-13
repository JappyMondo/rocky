# Rocky 🦝

Rocky runs AI development workflows on your own machine. Delegate a Linear issue,
then follow its progress, answer questions, review evidence, and approve the
result in the local web UI or Linear.

## Current capabilities

The CLI, daemon, workflow runtime and web UI are implemented and installable
from this checkout. Rocky is under active development; it is not published as
this project's `rocky` package on npm.

- **Linear delegation and durable runs:** issue text and comment history are
  captured at admission. Runs use owned Git clones and per-run worktrees,
  journal their steps, and replay after a daemon restart.
- **Editable local profiles:** one profile owns the workflow, prompts, schemas,
  rules, MCP configuration and repository membership. Profiles can span several
  repositories, with the first member serving as the default SCM target.
- **Two harness adapters:** `opencode` and `claude-code` drive the installed
  native CLIs. Workflows declare named model slots; the web UI configures each
  slot’s harness, model and variant/effort independently.
- **Shipped workflows:** clarify the issue, then deliver either a reviewed
  Linear comment or a PR/MR. The PR path implements validation, review/fix and CI
  loops, visual recaps, and an approval checkpoint before platform-controlled
  merge. A request can specify PR handoff without merging.
- **Local controls and evidence:** structured results, decoded live agent
  streams, diffs, screenshots, visual reports, questions, checkpoints, steering,
  cancellation, eligible failed-step retries, and fresh Linear delegation recovery.
- **Connections:** local UI management of Linear authentication and profile MCP
  servers, with OAuth, connection tests and per-profile grants.

These are implemented paths, not a guarantee that every ticket completes. Actual
execution needs working harness accounts, repository credentials, Linear setup,
and any tools required by the profile. The default PR workflow targets the lead
repository; multi-repository membership does not imply a PR for every member.

`rocky init`, `rocky upgrade` and `rocky trigger` remain failing CLI stubs. Manual
triggers are available through **New run** and the local API, but those runs have
no Linear Agent Session and cannot use the session-backed Linear/SCM services.
See the [CLI and context contract](docs/cli-and-ctx.md) for the precise boundary.

## Install from a local checkout

Requires Node 24 or newer, pnpm 10.33.1 (pinned in `package.json`), and macOS or
Linux. From the repository root:

```sh
pnpm install --frozen-lockfile
mkdir -p dist/tarballs
pnpm --dir packages/cli pack --pack-destination "$PWD/dist/tarballs"
npm install --global --ignore-scripts "$PWD/dist/tarballs/rocky-0.0.0.tgz"
rocky --version
rocky --help
```

The tarball bundles the CLI, daemon, web app, workflow assets and worker entry
points; ordinary runtime dependencies are installed by npm. This installs a
snapshot of the checkout. Rebuild and reinstall to pick up code changes, then
explicitly restart any running daemon. See [distribution](docs/distribution.md)
for clean-install verification, versioning and uninstall instructions.

**Use the explicit local tarball path.** The unscoped npm name `rocky` belongs to
an unrelated project; do not use bare `npx rocky` or `npm install -g rocky`.

## Start using Rocky

Install and sign into your chosen native harness first. For Linear delegation,
prepare a stable public HTTPS endpoint forwarding to **`http://127.0.0.1:7626`**
on the machine running Rocky, then run the interactive setup. This is the
ingress port; port `7625` serves the private UI/API and must not be exposed publicly.
Setup starts the ingress after you enter the public URL and installs it as a
background service when setup finishes:

```sh
rocky setup
rocky repo add git@github.com:YOUR_ORG/YOUR_REPO.git --label YOUR_LINEAR_LABEL
rocky doctor
rocky status
```

`setup` guides public endpoint/app configuration, OAuth and default model
selection, and installs managed daemon and ingress user services. `repo add`
clones the repository and asks which models and variant/effort to save in its
local profile. Review the profile's commands, Linear states and tool/MCP grants
in **Profiles** before delegating a matching labeled issue. The default workflow exposes **Review**, **Implementation** and **Planner** model slots; each can use its own harness, model and effort without editing workflow code. See [named workflow models](docs/workflow-models.md). For automation,
`repo add` requires `--harness`, `--model` and `--variant`; see [CLI details](docs/cli-and-ctx.md).

To open the local UI before connecting Linear, run `rocky start -d` and visit
<http://127.0.0.1:7625>. This makes the UI available; it does not configure
external accounts or make the shipped workflow usable without them.

The daemon has no application authentication. Public HTTPS must target the
separate `rocky-ingress` filter, which forwards only the Linear webhook, ping
and OAuth callback. Optional private Tailscale UI access is configured separately.
Follow the [endpoint guide](docs/public-endpoint.md).

## Where configuration lives

Production execution reads profiles under `~/.rocky` (or `ROCKY_HOME`):

```text
~/.rocky/
  config.json                # routing, server, harness and instance settings
  credentials.json           # machine credentials
  profiles/<id>.json         # repositories, prompts, schemas, rules, MCP, grants
  profiles/<id>.workflow.ts  # editable workflow source; overrides JSON source
  runs/<runId>/snapshot/     # frozen profile content for this run
  runs/<runId>/workspace/    # sibling repository worktrees
```

**Target-repository `.rocky/` files are ignored by production admission.** The
shipped template lives at `packages/daemon/content/.rocky/` and seeds local
profiles. Legacy repository seeding/onboarding helpers remain in the source,
but a missing repository `.rocky/` is not the current setup trigger.

Profile changes apply to future runs. Existing runs, including explicit step
retries, keep their snapshots. Use the profile editor, or `rocky repo profile`
to list, export, import, assign, seed or delete local profiles. See
[local product](docs/local-product.md) and the [architecture overview](docs/architecture.md).

## Lifecycle

```sh
rocky start                 # foreground daemon
rocky start -d              # detached daemon
rocky status                # version, address, pid, repositories and endpoint
rocky logs -f               # follow the daemon log across rotations
rocky restart               # explicit stop, then detached start
rocky stop
rocky doctor                # config, endpoint and harness authentication checks
rocky service install       # daemon + ingress launchd/systemd user services
rocky service uninstall     # unload and remove those services
```

Logs under `~/.rocky/logs/` rotate at 5 MB with five retained files. Services
run as the current user. Package installation alone does not install services.

## Working on Rocky

Nx/pnpm workspace:

| Path                       | Package                  | Purpose                                          |
| -------------------------- | ------------------------ | ------------------------------------------------ |
| `packages/cli`             | `rocky`                  | CLI and staged installable tarball               |
| `packages/daemon`          | `@rocky/daemon`          | API, execution, integrations and bundled web app |
| `packages/sdk`             | `@rocky/sdk`             | Workflow types, Trigger builders and Zod export  |
| `packages/local-contracts` | `@rocky/local-contracts` | Shared UI/API types                              |
| `apps/web`                 | `web`                    | Vite/React local UI                              |

```sh
pnpm exec prettier --check .
pnpm exec nx run-many -t build typecheck lint
pnpm exec nx run-many -t test --coverage
pnpm test:distribution
pnpm exec nx build rocky
node packages/cli/dist/main.js --help
```

CI checks formatting repository-wide, runs affected projects for PRs and all
projects on `main`, then verifies clean tarball installation. Coverage thresholds
are configured per project. GitHub Actions caches Nx results; dependency audit
and dependency review gate high-severity findings. The aggregate check is `ci`.
Node is pinned by `.nvmrc`.

Two `image-size` advisories are waived individually in
`pnpm.auditConfig.ignoreGhsas` (`GHSA-w3rx-r6r6-pgpr`, `GHSA-5p2g-fcmc-qvqq`).
The recorded rationale is their parser path through the unused optional Less
peer. Re-evaluate those exceptions when updating dependencies; keep the audit
severity gate intact.

See the [documentation index](docs/README.md) for implementation guides and
explicitly dated historical material. Tickets are tracked in Linear's Niotix
Grid team with a repository routing label.
