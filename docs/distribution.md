# Installing and distributing Rocky

Rocky requires Node 24 or newer on macOS or Linux. The installable artifact is
**one local npm tarball**, provisionally named `rocky`, containing the CLI, daemon code, the built local web
shell and the separately operated `rocky-ingress` filtering utility. Ordinary
third-party dependencies still install from npm; private workspace packages do
not. `@rocky/daemon` remains private. `@rocky/sdk` is a separate, independently
versioned developer dependency for consumer Workflows, not a prerequisite to
installing Rocky.

## Current availability

**Public naming and namespace ownership block release.** On 2026-09-07, the
public registry's `rocky@latest` was `0.4.16`, pointing at
[`h2non/rocky`](https://github.com/h2non/rocky), an unrelated proxy package.
Do not use bare `npx rocky`, `npm install rocky`, or registry version examples
for this project. No replacement scoped name or scope ownership has been
established. `rocky` is only a provisional name inside our local tarballs, and
the source and staged CLI manifests are `private: true` to prevent publication.
The SDK's registry namespace also needs ownership verification before release.

Use an explicit reviewed tarball, and invoke its local binaries rather than a
potentially unrelated command already installed globally:

```sh
npm install --ignore-scripts /absolute/path/to/rocky-<version>.tgz
./node_modules/.bin/rocky start -d
./node_modules/.bin/rocky status
./node_modules/.bin/rocky stop
```

The filter binary is `./node_modules/.bin/rocky-ingress` from that same install.
Registry installation instructions must be written only after a maintainer
proves ownership of the chosen scoped package and authorizes its release.
The local API and web
shell use `http://127.0.0.1:7625` by default. They have no authentication and must
never be exposed publicly. Follow [the public endpoint guide](public-endpoint.md)
to run `rocky-ingress` and connect a BYO stable HTTPS tunnel to the filter, not to
the daemon. The package contains that guide under `docs/public-endpoint.md`.

The current artifact contains the foundation, local lifecycle commands and web
shell, not a completed delegation-to-PR product. Installing successfully is not
evidence of runnable Harnesses, default Workflow, Onboarding or Run control.
Those integrations have their own acceptance gates.

## Building and verifying

Use the repository's pinned pnpm and Node versions:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/cli pack --pack-destination /existing/output/directory
pnpm test:distribution
```

`prepack` builds the CLI/daemon/SDK and web shell via Nx, then esbuild bundles
Rocky's workspace modules into the staged `packages/cli/dist/package/dist`.
Non-workspace dependencies remain external. A generated distribution manifest
carries only runtime dependencies, binaries and assets; it contains no workspace
references, source exports, development dependencies or install scripts. pnpm's
`publishConfig.directory` selects that staging directory. Do not use `npm pack`
on the source package: npm does not honor this pnpm staging contract.

Both bundled version readers stay at `<dist>/../package.json`, now the same
`rocky` artifact manifest. The daemon captures its version on process startup;
replacing the installed CLI cannot silently update a live daemon. A mismatch
prints the existing `rocky restart` hint. Restart is explicit, never automatic.

The distribution smoke test packs, installs with scripts disabled in a clean
directory outside the repository and with isolated HOME/npm configuration, then
invokes `node_modules/.bin/rocky` from that exact install, never a registry-resolved
command. It checks the default port,
web shell and asset, ingress binary, version mismatch without auto-restart,
explicit restart and stop. It refuses an occupied port rather than touching an
existing daemon. CI runs this after the project suites, not concurrently with
another daemon test using the default port. No real credentials or public
endpoint are required. It then packs `@rocky/sdk` and typechecks a consumer
Workflow in a second clean directory containing neither `rocky` nor
`@rocky/daemon`, then imports its real schema library and Trigger table in Node.
The SDK's own `prepack` builds its types and Trigger builders.

For installed-artifact browser acceptance, install `agent-browser` independently
and run `ROCKY_DISTRIBUTION_BROWSER=1 pnpm test:distribution`. This opt-in local
check opens the installed shell in an isolated Chromium session, waits for its
React-rendered daemon health, checks desktop/mobile widths and page errors, and
closes the session. It was run for this slice; the default CI smoke proves
static delivery and SDK execution but does not download or run a browser. Repeat
browser acceptance when changing the packaged UI or its asset layout.

## Version and release policy

- `packages/cli/package.json` is the version authority for the local `rocky`
  artifact and its bundled daemon. The private daemon package version is only
  a workspace-development artifact, not a separately released version.
- `packages/sdk/package.json` versions independently under semver. It contains
  types, Trigger builders and the schema library, never the default Workflow or
  a dependency on the daemon. SDK API changes belong to the runtime/SDK owner.
- Releases are manual. CI validates builds, tests, audit and clean installs but
  has no publish credential or release job. No auto-publishing or auto-updating.
- A maintainer must prove ownership of an appropriate scoped name (the public
  unscoped `rocky` is unrelated), explicitly authorize release, rename the
  package, remove its private guard and bump its version in a reviewed change.
  Obtain independent review and green `ci`
  on the integrated head, and repeat the clean-install smoke test on that exact
  tarball. Only then may they publish that reviewed artifact and record its
  integrity/version. These instructions do not authorize publication.
- Foundation tarballs at `0.0.0` are local test artifacts. Final MVP acceptance
  repeats packaging tests after runtime, Harness, MCP, content and UI integration
  has landed. New runtime data files, dynamic loaders and subprocess entries
  must be added to packaging and its smoke test when introduced.
