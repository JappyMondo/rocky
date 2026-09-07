import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const cliRoot = join(root, 'packages/cli');
const output = join(cliRoot, 'dist/package');
const manifests = await Promise.all(
  ['sdk', 'daemon', 'cli'].map(async (name) =>
    JSON.parse(
      await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
    ),
  ),
);
const cli = manifests[2];
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
  },
  outdir: join(output, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: Object.keys(dependencies),
  metafile: true,
});
for (const file of Object.values(result.metafile.outputs)) {
  for (const imported of file.imports) {
    if (imported.path.startsWith('@rocky/'))
      throw new Error(`Workspace import escaped the bundle: ${imported.path}`);
  }
}
await cp(join(root, 'packages/daemon/public'), join(output, 'public'), {
  recursive: true,
});
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
await cp(join(root, 'docs/distribution.md'), join(output, 'README.md'));
await cp(
  join(root, 'docs/public-endpoint.md'),
  join(output, 'docs/public-endpoint.md'),
  { recursive: true },
);
await writeFile(
  join(output, 'package.json'),
  `${JSON.stringify(
    {
      name: cli.name,
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
      files: ['dist', 'public', 'docs', 'LICENSE', 'README.md'],
      dependencies,
    },
    null,
    2,
  )}\n`,
);
