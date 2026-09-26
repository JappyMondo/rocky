import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const workspace = resolve(import.meta.dirname, '..');
const port = Number(process.env.ROCKY_DISTRIBUTION_PORT ?? 7625);
const origin = `http://127.0.0.1:${port}`;

test(
  'packed Rocky installs outside the workspace and carries its daemon, UI, ingress and version',
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'rocky-distribution-'));
    const consumer = join(root, 'consumer');
    const home = join(root, 'home');
    await mkdir(consumer);
    await mkdir(home);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      ROCKY_HOME: join(home, '.rocky'),
      XDG_CONFIG_HOME: join(home, '.config'),
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_registry: 'https://registry.npmjs.org',
      npm_config_userconfig: join(root, 'empty.npmrc'),
      npm_config_globalconfig: join(root, 'empty-global.npmrc'),
      AGENT_BROWSER_SOCKET_DIR: join(root, 'ab'),
    };
    await writeFile(env.npm_config_userconfig, '');
    await writeFile(env.npm_config_globalconfig, '');
    if (process.env.ROCKY_DISTRIBUTION_PORT) {
      await mkdir(env.ROCKY_HOME, { recursive: true });
      await writeFile(
        join(env.ROCKY_HOME, 'config.json'),
        JSON.stringify({ server: { host: '127.0.0.1', port } }),
      );
    }
    const run = (command, args, cwd = consumer, extra = {}) =>
      execFileSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        ...extra,
      });
    const binary = join(consumer, 'node_modules/.bin/rocky');
    const cli = (...args) => run(binary, args);
    const local = (path) =>
      fetch(`${origin}${path}`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(3000),
      });
    const pidFile = join(env.ROCKY_HOME, 'daemon.pid');
    t.after(async () => {
      // This private pidfile can only have been written by our own child.
      try {
        const record = JSON.parse(await readFile(pidFile, 'utf8'));
        process.kill(record.pid, 'SIGTERM');
        for (let i = 0; i < 100; i++) {
          try {
            await readFile(pidFile);
          } catch {
            break;
          }
          await sleep(20);
        }
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
      await rm(root, { recursive: true, force: true });
    });
    // Refuse an occupied test port. Never stop an existing developer daemon.
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => reservation.close(resolve));

    execFileSync(
      'pnpm',
      ['--dir', 'packages/cli', 'pack', '--pack-destination', root],
      { cwd: workspace, env: process.env, stdio: 'pipe', timeout: 120_000 },
    );
    const archive = (await readdir(root)).find((name) =>
      /^rocky-.*\.tgz$/.test(name),
    );
    assert.ok(archive, 'rocky tarball was produced');
    await writeFile(
      join(consumer, 'package.json'),
      '{"name":"clean-rocky-consumer","private":true,"type":"module"}',
    );
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, archive),
    ]);
    const installed = join(consumer, 'node_modules', 'rocky');
    const manifestPath = join(installed, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'rocky');
    assert.equal(
      manifest.private,
      true,
      'publication is blocked until namespace ownership is established',
    );
    assert.ok(
      Object.keys(manifest.dependencies).every(
        (name) => !name.startsWith('@rocky/'),
      ),
    );
    assert.ok(!JSON.stringify(manifest).includes('workspace:'));
    assert.ok(!manifest.scripts, 'consumers do not need build/install scripts');
    assert.equal(cli('--version').trim(), manifest.version);
    assert.match(
      run(join(consumer, 'node_modules/.bin/rocky-ingress'), ['--help']),
      /Webhook, ping and OAuth-callback filtering proxy/i,
    );
    assert.match(
      await readFile(join(installed, 'docs', 'mcp.md'), 'utf8'),
      /rocky mcp login/,
    );
    assert.match(
      await readFile(join(installed, 'docs', 'workflow-models.md'), 'utf8'),
      /ctx\.models/,
    );
    assert.match(
      await readFile(join(installed, 'docs', 'source-control.md'), 'utf8'),
      /rocky exec/,
    );
    assert.equal(
      cli(
        'exec',
        '--',
        process.execPath,
        '-p',
        'process.env.GIT_AUTHOR_NAME',
      ).trim(),
      'Rocky',
    );
    // Agent's production resolver loads this path lazily from boot-child.js;
    // its absence only surfaces when a real Agent Step starts.
    await readFile(join(installed, 'harness', 'adapter.js'), 'utf8');
    // Workflow validation forks these files after the first Agent Step, so
    // the normal CLI smoke cannot exercise their dynamic URL imports.
    for (const file of [
      'validate-child.js',
      'validate-worker.js',
      'loader.js',
      'flow-runtime.js',
    ])
      await readFile(join(installed, 'dist', file), 'utf8');
    const syntax = JSON.parse(
      run(
        process.execPath,
        [join(installed, 'dist', 'mermaid-check.js'), '--source'],
        consumer,
        { input: 'flowchart LR\nA["API<br/>entry"] --> B' },
      ),
    );
    assert.equal(syntax.ok, true);
    assert.equal(syntax.rendered, false);
    assert.equal(syntax.diagrams.length, 1);
    const seedHome = join(root, 'seed-instance');
    await mkdir(seedHome);
    await writeFile(
      join(seedHome, 'config.json'),
      JSON.stringify({
        repos: [
          {
            name: 'fixture',
            url: 'https://example.test/acme/fixture.git',
            baseBranch: 'main',
            label: 'fixture',
          },
        ],
      }),
    );
    run(
      binary,
      [
        'repo',
        'profile',
        'seed',
        'fixture',
        '--harness',
        'opencode',
        '--model',
        'provider/main-model',
        '--variant',
        'high',
        '--fast-harness',
        'claude-code',
        '--fast-model',
        'claude-helper-model',
        '--fast-variant',
        'low',
      ],
      consumer,
      { env: { ...env, ROCKY_HOME: seedHome } },
    );
    const pinnedWorkflow = await readFile(
      join(seedHome, 'profiles/flows/fixture.json'),
      'utf8',
    );
    assert.equal(JSON.parse(pinnedWorkflow).version, 2);
    assert.doesNotMatch(
      pinnedWorkflow,
      /provider\/main-model|claude-helper-model/,
    );
    const seeded = JSON.parse(
      await readFile(join(seedHome, 'profiles/fixture.json'), 'utf8'),
    );
    assert.deepEqual(seeded.models, {
      review: {
        harness: 'opencode',
        model: 'provider/main-model',
        effort: 'high',
      },
      implementation: {
        harness: 'opencode',
        model: 'provider/main-model',
        effort: 'high',
      },
      planner: {
        harness: 'claude-code',
        model: 'claude-helper-model',
        effort: 'low',
      },
    });
    const seedSnapshot = join(root, 'seed-snapshot');
    await cp(join(installed, 'content', '.rocky'), seedSnapshot, {
      recursive: true,
    });
    const triggerTable = run(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { importSnapshotTriggers } = await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'loader.js')).href)});
       console.log(JSON.stringify((await importSnapshotTriggers(${JSON.stringify(seedSnapshot)})).map(({ descriptor }) => descriptor)));`,
    ]);
    assert.match(triggerTable, /linear\.onDelegate/);
    // Execute a config graph through the packed loader, outside the workspace.
    const configured = JSON.parse(pinnedWorkflow);
    assert.equal(configured.settings.recoveryVersion, 1);
    assert.equal(configured.settings.ciRetryVersion, 1);
    assert.equal(configured.settings.scopeCommentVersion, 1);
    configured.models = {};
    configured.nodes = [
      {
        id: 'start',
        type: 'trigger',
        name: 'Start',
        position: { x: 0, y: 0 },
        parameters: { kind: 'manual', name: 'smoke' },
      },
      {
        id: 'command',
        type: 'command',
        name: 'Check',
        position: { x: 250, y: 0 },
        parameters: { command: 'printf flow' },
      },
      {
        id: 'end',
        type: 'finish',
        name: 'Done',
        position: { x: 500, y: 0 },
        parameters: { outcome: 'completed' },
      },
    ];
    configured.edges = [
      { id: 'start', source: 'start', sourceHandle: 'next', target: 'command' },
      {
        id: 'success',
        source: 'command',
        sourceHandle: 'success',
        target: 'end',
      },
      {
        id: 'failure',
        source: 'command',
        sourceHandle: 'failure',
        target: 'end',
      },
    ];
    await writeFile(
      join(seedSnapshot, 'workflow.json'),
      JSON.stringify(configured),
    );
    const executed = run(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { importSnapshotTriggers } = await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'loader.js')).href)});
       const [binding] = await importSnapshotTriggers(${JSON.stringify(seedSnapshot)});
       const commands = [];
       const outcome = await binding.workflow({ issue: {}, stage() {}, exec: async (command) => { commands.push(command); return { exitCode: 0, stdout: 'flow', stderr: '' }; } }, {});
       console.log(JSON.stringify({ outcome, commands }));`,
    ]);
    assert.deepEqual(JSON.parse(executed), {
      outcome: 'completed',
      commands: ['cd -- "$ROCKY_LEAD_REPO" && printf flow'],
    });

    for (const file of await readdir(join(installed, 'dist'))) {
      if (file.endsWith('.js'))
        assert.doesNotMatch(
          await readFile(join(installed, 'dist', file), 'utf8'),
          /(?:from\s*|import\s*\(|require\s*\()['"]@rocky\//,
        );
    }
    assert.ok(
      cli(
        'start',
        '-d',
        ...(process.env.ROCKY_DISTRIBUTION_PORT
          ? ['--port', String(port)]
          : []),
      ).includes(origin),
    );
    const firstPid = JSON.parse(await readFile(pidFile, 'utf8')).pid;
    const health = await local('/api/health');
    assert.equal(health.headers.get('x-rocky-version'), manifest.version);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      version: manifest.version,
      web: true,
      endpoint: { configured: false, ok: false },
    });
    const html = await (await local('/')).text();
    assert.match(html, /<div id="root">/);
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset);
    const assetResponse = await local(asset);
    assert.equal(assetResponse.status, 200);
    assert.ok((await assetResponse.text()).length > 0);

    // Optional local acceptance with an independently installed agent-browser.
    // CI's deterministic smoke remains usable without downloading a browser.
    if (process.env.ROCKY_DISTRIBUTION_BROWSER === '1') {
      const session = `rp${process.pid}`;
      await mkdir(env.AGENT_BROWSER_SOCKET_DIR);
      const browser = (...args) =>
        run('agent-browser', ['--session', session, ...args]);
      try {
        browser('open', origin);
        browser('wait', '--text', 'Ready when you are.');
        assert.match(browser('snapshot'), /heading "Runs"/);
        browser('set', 'viewport', '390', '844');
        assert.ok(
          browser('get', 'text', 'body').includes('Ready when you are.'),
        );
        const errors = JSON.parse(browser('errors', '--json'));
        assert.deepEqual(errors.data.errors, []);
        console.log(
          'Installed web shell mounted in Chromium at desktop and mobile widths; no page errors.',
        );
      } finally {
        browser('close');
      }
    }

    // An installed replacement CLI must warn, not silently restart a live Run.
    const nextVersion = `${manifest.version}-smoke-next`;
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: nextVersion }),
    );
    const mismatch = spawnSync(binary, ['status'], {
      cwd: consumer,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(mismatch.status, 0, mismatch.stderr);
    assert.match(mismatch.stderr, /rocky restart/);
    assert.ok(
      mismatch.stderr.includes(
        `daemon is v${manifest.version}, you're v${nextVersion}`,
      ),
    );
    assert.equal(JSON.parse(await readFile(pidFile, 'utf8')).pid, firstPid);
    assert.ok(cli('restart').includes(origin));
    assert.equal(
      (await (await local('/api/health')).json()).version,
      nextVersion,
    );
    assert.match(cli('stop'), /stopped/i);
    await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
    console.log(
      `Clean install passed: ${archive}; Node ${process.version}; ${origin}; UI asset, ingress bin, version/restart and stop.`,
    );

    const sdkConsumer = join(root, 'sdk-consumer');
    await mkdir(sdkConsumer);
    execFileSync(
      'pnpm',
      ['--dir', 'packages/sdk', 'pack', '--pack-destination', root],
      { cwd: workspace, env: process.env, stdio: 'pipe', timeout: 120_000 },
    );
    const sdkArchive = (await readdir(root)).find((name) =>
      /^rocky-sdk-.*\.tgz$/.test(name),
    );
    assert.ok(sdkArchive);
    await writeFile(
      join(sdkConsumer, 'package.json'),
      '{"name":"clean-sdk-consumer","private":true,"type":"module"}',
    );
    const { devDependencies } = JSON.parse(
      await readFile(join(workspace, 'package.json'), 'utf8'),
    );
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-dev',
        join(root, sdkArchive),
        `typescript@${devDependencies.typescript}`,
      ],
      sdkConsumer,
    );
    await mkdir(join(sdkConsumer, '.rocky'));
    await writeFile(
      join(sdkConsumer, '.rocky/workflow.ts'),
      `import { linear, manual, z, type Workflow, type WorkflowModelSlots } from '@rocky/sdk';
export const models = { planner: { name: 'Planner' } } satisfies WorkflowModelSlots;
const workflow: Workflow = async (ctx) => {
  ctx.stage('checking');
  const plan = await ctx.agent('planner', { ...ctx.models.planner, schema: z.object({ steps: z.array(z.string()) }) });
  const checks = await ctx.parallel(
    ['git status --short'],
    (command, index) => ctx.exec(command, { label: \`check \${index + 1}\` }),
    { label: 'checks' },
  );
  await ctx.exec('node --version', { background: true, label: 'version' });
  await ctx.step('count', () => plan.steps.length + checks.length + ctx.ports.length);
  return 'merged';
};
export default [linear.onDelegate(workflow), manual('review', workflow)];
`,
    );
    run(
      'npx',
      [
        '--no-install',
        '--',
        'tsc',
        '--noEmit',
        '--strict',
        '--module',
        'NodeNext',
        '--target',
        'ES2022',
        '.rocky/workflow.ts',
      ],
      sdkConsumer,
    );
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
import assert from 'node:assert/strict';
import { z } from '@rocky/sdk';
import table, { models } from './.rocky/workflow.ts';
assert.equal(z.string().parse('ok'), 'ok');
assert.deepEqual(table.map((trigger) => trigger.kind), ['linear.onDelegate', 'manual']);
assert.equal(table[1].name, 'review');
assert.ok(table.every(Object.isFrozen));
assert.deepEqual(models, { planner: { name: 'Planner' } });
const choice = { harness: 'opencode', model: 'provider/planner', effort: 'high' };
const outcome = await table[0].workflow({
  models: { planner: choice }, ports: [1234], stage() {},
  async agent(name, opts) { assert.equal(name, 'planner'); for (const key of Object.keys(choice)) assert.equal(opts[key], choice[key]); return { steps: ['plan'], summary: 'done' }; },
  async parallel(items, fn) { return Promise.all(items.map(fn)); },
  async exec(command, opts) { return opts?.background ? { pid: 1 } : { exitCode: 0, stdout: '', stderr: '' }; },
  async step(label, fn) { return fn(); },
}, { members: [] });
assert.equal(outcome, 'merged');
`,
      ],
      sdkConsumer,
    );
    await assert.rejects(
      readFile(join(sdkConsumer, 'node_modules/@rocky/daemon/package.json')),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      readFile(join(sdkConsumer, 'node_modules/rocky/package.json')),
      { code: 'ENOENT' },
    );
    console.log(
      `SDK-only consumer passed: ${sdkArchive}; Workflow typechecks its current ctx surface and its Trigger table imports/runs without rocky or @rocky/daemon.`,
    );
  },
);
