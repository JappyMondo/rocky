import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const cliRoot = join(root, 'packages/cli');
const output = join(cliRoot, 'dist/package');
const manifests = await Promise.all(
  ['sdk', 'daemon', 'local-contracts', 'cli'].map(async (name) =>
    JSON.parse(
      await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
    ),
  ),
);
const cli = manifests.at(-1);
const dependencies = Object.fromEntries(
  Object.entries(
    Object.assign({}, ...manifests.map((manifest) => manifest.dependencies)),
  ).filter(([name, version]) => {
    if (!version.startsWith('workspace:')) return true;
    if (!manifests.some((manifest) => manifest.name === name))
      throw new Error(`Unpackaged workspace dependency: ${name}`);
    return false;
  }),
);

execFileSync('pnpm', ['exec', 'nx', 'build', 'rocky'], {
  cwd: root,
  stdio: 'inherit',
});
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    main: 'packages/cli/src/main.ts',
    'ingress-main': 'packages/cli/src/ingress-main.ts',
    // RunWorkers forks this sibling by URL. It cannot be folded into main:
    // the child has its own IPC lifecycle and must exist in the tarball.
    'boot-child': 'packages/daemon/src/run/boot-child.ts',
    // Node will not type-strip a raw .ts file under installed node_modules.
    // Keep the seed content raw, but bundle Rocky's own onboarding runner.
    onboarding: 'packages/daemon/content/onboarding.ts',
    // Workflow validation supervises its import in separate processes. Each
    // URL is resolved beside dist/boot-child.js in an installed package.
    'validate-child': 'packages/daemon/src/run/loading/validate-child.ts',
    'validate-worker': 'packages/daemon/src/run/loading/validate-worker.ts',
    loader: 'packages/daemon/src/run/loading/loader.ts',
    // Seeded workflows import this from the isolated snapshot process.
    sdk: 'packages/sdk/src/index.ts',
  },
  outdir: join(output, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: Object.keys(dependencies),
  metafile: true,
});
// Agent's adapter loader is intentionally late-bound so tests and embedders can
// supply a harness.  Its production fallback resolves this package-root path
// from dist/boot-child.js, therefore it must be emitted outside dist as well.
const harness = await build({
  absWorkingDir: root,
  entryPoints: ['packages/daemon/src/harness/adapter.ts'],
  outfile: join(output, 'harness', 'adapter.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: Object.keys(dependencies),
  metafile: true,
});
for (const file of [
  ...Object.values(result.metafile.outputs),
  ...Object.values(harness.metafile.outputs),
]) {
  for (const imported of file.imports) {
    if (imported.path.startsWith('@rocky/'))
      throw new Error(`Workspace import escaped the bundle: ${imported.path}`);
  }
}
await cp(join(root, 'packages/daemon/public'), join(output, 'public'), {
  recursive: true,
});
// Onboarding imports this tree at runtime instead of bundling it: seed output
// must remain raw, reviewable TypeScript and Markdown in the installed artifact.
await cp(join(root, 'packages/daemon/content'), join(output, 'content'), {
  recursive: true,
});
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
await cp(join(root, 'docs/distribution.md'), join(output, 'README.md'));
await cp(
  join(root, 'docs/public-endpoint.md'),
  join(output, 'docs/public-endpoint.md'),
  { recursive: true },
);
await cp(join(root, 'docs/mcp.md'), join(output, 'docs/mcp.md'));
await writeFile(
  join(output, 'package.json'),
  `${JSON.stringify(
    {
      name: cli.name,
      private: cli.private,
      version: cli.version,
      description: cli.description,
      license: cli.license,
      type: 'module',
      engines: cli.engines,
      repository: {
        type: 'git',
        url: 'https://github.com/JappyMondo/rocky.git',
      },
      bin: cli.bin,
      files: [
        'dist',
        'harness',
        'public',
        'content',
        'docs',
        'LICENSE',
        'README.md',
      ],
      dependencies,
    },
    null,
    2,
  )}\n`,
);
