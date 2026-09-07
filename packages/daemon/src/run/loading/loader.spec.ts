import { execFile, spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { validateSnapshotTriggers } from './validate.js';
import { resolveSnapshotTrigger } from './loader.js';

const exec = promisify(execFile);
const directories: string[] = [];
const loader = new URL('./loader.ts', import.meta.url).href;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(workflow: string) {
  const dir = await mkdtemp(join(tmpdir(), 'rocky-loader-'));
  directories.push(dir);
  await writeFile(join(dir, 'workflow.ts'), workflow);
  return dir;
}

async function execute(dir: string) {
  const { stdout } = await exec(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    const { loadSnapshotWorkflow } = await import(${JSON.stringify(loader)});
    const workflow = await loadSnapshotWorkflow(${JSON.stringify(dir)}, { kind: 'linear.onDelegate' });
    console.log(JSON.stringify(await workflow()));
  `,
  ]);
  return JSON.parse(stdout.trim());
}

it('loads consumer TypeScript with SDK types, installed exports and relative .js helpers without a build', async () => {
  const dir = await fixture(`
    import { linear, type Workflow } from '@rocky/sdk';
    import { z } from 'zod';
    import { result } from './helper.js';
    const workflow: Workflow = async () => z.object({ status: z.literal('completed') }).parse(result);
    export default [linear.onDelegate(workflow)];
  `);
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
  await writeFile(
    join(dir, 'helper.ts'),
    `export const result: { status: string } = { status: 'completed' };`,
  );
  expect(await execute(dir)).toEqual({ status: 'completed' });
});

it('validates top-level code outside the daemon and bounds nonterminating imports', async () => {
  const valid = await fixture(`
    import { linear, manual } from '@rocky/sdk';
    if (typeof ctx !== 'undefined') throw new Error('ctx leaked into module scope');
    process.env.ROCKY_LOADER_TEST = 'child only';
    setInterval(() => {}, 1000);
    export default [linear.onDelegate(async () => {}), manual('repair', async () => {})];
  `);
  expect(await validateSnapshotTriggers(valid)).toEqual([
    { kind: 'linear.onDelegate' },
    { kind: 'manual', name: 'repair' },
  ]);
  expect(process.env.ROCKY_LOADER_TEST).toBeUndefined();
  const hanging = await fixture('while (true) {}');
  await expect(
    validateSnapshotTriggers(hanging, { validationTimeoutMs: 150 }),
  ).rejects.toThrow(/workflow.ts.*timed out.*top-level/s);
});

it('aborts an active validation import without waiting for its timeout', async () => {
  const dir = await fixture('while (true) {}');
  const controller = new AbortController();
  const result = validateSnapshotTriggers(dir, { signal: controller.signal });
  const rejection = expect(result).rejects.toThrow('admission cancelled');
  controller.abort(new Error('admission cancelled'));
  await rejection;
  await expect(
    validateSnapshotTriggers(dir, { signal: controller.signal }),
  ).rejects.toThrow('admission cancelled');
});

it.each([
  ['export default []', 'nonempty'],
  ['export default {}', 'nonempty'],
  ['export default new Array(1)', 'callable'],
  [
    'export default [{ kind: "linear.onDelegate", workflow() {} }, ,]',
    'callable',
  ],
  [
    'export default [{ kind: "cron", workflow() {} }]',
    'only linear.onDelegate',
  ],
  [
    'export default [{ kind: "manual", name: "", workflow() {} }]',
    'nonemptyName',
  ],
  ['export default [{ kind: "linear.onDelegate", workflow: 42 }]', 'callable'],
  [
    'import { manual } from "@rocky/sdk"; export default [manual("repair", async () => {}), manual("repair", async () => {})]',
    'duplicate Trigger manual:repair',
  ],
  [
    'import { linear } from "@rocky/sdk"; export default [linear.onDelegate(async () => {}), linear.onDelegate(async () => {})]',
    'duplicate Trigger linear.onDelegate',
  ],
  ['import "./missing.ts";', 'missing.ts'],
  ['export default [', 'Expression expected'],
])(
  'refuses malformed tables/imports with a file, error and fix: %s',
  async (source, reason) => {
    const dir = await fixture(source);
    await expect(validateSnapshotTriggers(dir)).rejects.toThrow(reason);
    await expect(validateSnapshotTriggers(dir)).rejects.toThrow(
      /workflow.ts.*Fix/s,
    );
  },
);

it('names the exact fix for absent delegation and manual Triggers', () => {
  const table = [{ kind: 'manual' as const, name: 'repair' }];
  expect(
    resolveSnapshotTrigger(table, { kind: 'manual', name: 'repair' }),
  ).toEqual(table[0]);
  expect(() =>
    resolveSnapshotTrigger(table, { kind: 'linear.onDelegate' }),
  ).toThrow(
    'Add linear.onDelegate(workflow) to the default export or fire a manual Trigger.',
  );
  expect(() =>
    resolveSnapshotTrigger(table, { kind: 'manual', name: 'other' }),
  ).toThrow(
    'Add that manual(name, workflow) binding or choose an existing manual Trigger.',
  );
});

it('isolates the complete relative module graph on every load and between snapshots', async () => {
  const source = `import { linear } from '@rocky/sdk'; import { next } from './helper.js';
    export default [linear.onDelegate(async () => ({ value: next() }))];`;
  const first = await fixture(source);
  const second = await fixture(source);
  await writeFile(
    join(first, 'helper.ts'),
    'let count = 0; export const next = () => ++count;',
  );
  await writeFile(
    join(second, 'helper.ts'),
    'let count = 40; export const next = () => ++count;',
  );
  const { stdout } = await exec(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    const { loadSnapshotWorkflow } = await import(${JSON.stringify(loader)});
    const selector = { kind: 'linear.onDelegate' };
    const first = await loadSnapshotWorkflow(${JSON.stringify(first)}, selector);
    const second = await loadSnapshotWorkflow(${JSON.stringify(second)}, selector);
    const fresh = await loadSnapshotWorkflow(${JSON.stringify(first)}, selector);
    console.log(JSON.stringify([await first(), await first(), await second(), await fresh()]));
  `,
  ]);
  expect(JSON.parse(stdout.trim())).toEqual([
    { value: 1 },
    { value: 2 },
    { value: 41 },
    { value: 1 },
  ]);
});

it('refuses relative and symlink module escapes instead of reading live files', async () => {
  const outside = await fixture('export const value = 42;');
  const escaping = await fixture(
    `import ${JSON.stringify(join(outside, 'workflow.ts'))};`,
  );
  await expect(validateSnapshotTriggers(escaping)).rejects.toThrow(
    'import escapes snapshot',
  );
  await writeFile(join(escaping, 'workflow.ts'), `import './helper.js';`);
  await symlink(join(outside, 'workflow.ts'), join(escaping, 'helper.ts'));
  await expect(validateSnapshotTriggers(escaping)).rejects.toThrow(
    'symlink import escapes snapshot',
  );
});

it('does not lint late Agent files or MCP names while discovering the table', async () => {
  const dir = await fixture(`import { linear } from '@rocky/sdk';
    export default [linear.onDelegate(async ctx => ctx.agent('missing.md', { mcp: ['unknown'] }))];`);
  expect(await validateSnapshotTriggers(dir)).toEqual([
    { kind: 'linear.onDelegate' },
  ]);
});

it('loads with a packed SDK and relocated runner, without workspace source conditions or consumer dependencies', async () => {
  const consumer =
    await fixture(`import { linear, type Workflow } from '@rocky/sdk';
    import { z } from 'zod'; const workflow: Workflow = async () => ({ value: z.number().parse(7) });
    export default [linear.onDelegate(workflow)];`);
  const install = await mkdtemp(join(tmpdir(), 'rocky-installed-'));
  directories.push(install);
  const sdk = join(install, 'node_modules/@rocky/sdk');
  await mkdir(sdk, { recursive: true });
  const archive = join(install, 'sdk.tgz');
  await exec('pnpm', ['pack', '--out', archive], {
    cwd: fileURLToPath(new URL('../../../../sdk', import.meta.url)),
  });
  await exec('tar', ['-xzf', archive, '-C', sdk, '--strip-components=1']);
  const require = createRequire(import.meta.url);
  await cp(
    dirname(require.resolve('zod/package.json')),
    join(install, 'node_modules/zod'),
    { recursive: true },
  );
  const installedLoader = join(
    install,
    'node_modules/@rocky/daemon/loader.mjs',
  );
  await mkdir(dirname(installedLoader), { recursive: true });
  await writeFile(
    installedLoader,
    stripTypeScriptTypes(await readFile(new URL(loader), 'utf8')),
  );
  const { stdout } = await exec(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    const { loadSnapshotWorkflow } = await import(${JSON.stringify(pathToFileURL(installedLoader).href)});
    const workflow = await loadSnapshotWorkflow(${JSON.stringify(consumer)}, { kind: 'linear.onDelegate' });
    console.log(JSON.stringify(await workflow()));
  `,
    ],
    { cwd: install, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  expect(JSON.parse(stdout.trim())).toEqual({ value: 7 });
});

it('kills a blocked import and its ordinary descendants when the validation owner disappears', async () => {
  const dir = await fixture(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    writeFileSync(new URL('./pids.json', import.meta.url), JSON.stringify([process.pid, descendant.pid]));
    while (true) {}
  `);
  const runner = await mkdtemp(join(tmpdir(), 'rocky-validation-owner-'));
  directories.push(runner);
  await writeFile(join(runner, 'package.json'), '{"type":"module"}');
  for (const name of [
    'validate',
    'loader',
    'validate-child',
    'validate-worker',
  ]) {
    await writeFile(
      join(runner, `${name}.js`),
      stripTypeScriptTypes(
        await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8'),
      ),
    );
  }
  const owner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    const { validateSnapshotTriggers } = await import(${JSON.stringify(pathToFileURL(join(runner, 'validate.js')).href)});
    await validateSnapshotTriggers(${JSON.stringify(dir)}, { validationTimeoutMs: 30000 });
  `,
    ],
    { stdio: 'ignore' },
  );
  let pids: number[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await expect
      .poll(async () => {
        pids = JSON.parse(await readFile(join(dir, 'pids.json'), 'utf8'));
        return pids.length;
      })
      .toBe(2);
    owner.kill('SIGKILL');
    await expect.poll(() => pids.some(alive), { timeout: 5000 }).toBe(false);
  } finally {
    owner.kill('SIGKILL');
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});
