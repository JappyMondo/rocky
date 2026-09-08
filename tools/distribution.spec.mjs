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
      fetch(`http://127.0.0.1:7625${path}`, {
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
    // Refuse an occupied default port. Never stop an existing developer daemon.
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(7625, '127.0.0.1', resolve);
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
    // Agent's production resolver loads this path lazily from boot-child.js;
    // its absence only surfaces when a real Agent Step starts.
    await readFile(join(installed, 'harness', 'adapter.js'), 'utf8');
    // Workflow validation forks these files after the first Agent Step, so
    // the normal CLI smoke cannot exercise their dynamic URL imports.
    for (const file of ['validate-child.js', 'validate-worker.js', 'loader.js'])
      await readFile(join(installed, 'dist', file), 'utf8');
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
    for (const file of await readdir(join(installed, 'dist'))) {
      if (file.endsWith('.js'))
        assert.doesNotMatch(
          await readFile(join(installed, 'dist', file), 'utf8'),
          /(?:from\s*|import\s*\(|require\s*\()['"]@rocky\//,
        );
    }
    assert.match(cli('start', '-d'), /127\.0\.0\.1:7625/);
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
        browser('open', 'http://127.0.0.1:7625');
        browser('wait', '--text', `Daemon v${manifest.version} is ok.`);
        assert.match(browser('snapshot'), /heading "Rocky"/);
        browser('set', 'viewport', '390', '844');
        assert.ok(
          browser('get', 'text', 'body').includes(
            `Daemon v${manifest.version} is ok.`,
          ),
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
    assert.match(cli('restart'), /127\.0\.0\.1:7625/);
    assert.equal(
      (await (await local('/api/health')).json()).version,
      nextVersion,
    );
    assert.match(cli('stop'), /stopped/i);
    await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
    console.log(
      `Clean install passed: ${archive}; Node ${process.version}; 127.0.0.1:7625; UI asset, ingress bin, version/restart and stop.`,
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
      `import { linear, manual, z, type Workflow } from '@rocky/sdk';
const workflow: Workflow = async (ctx) => {
  ctx.stage('checking');
  const plan = await ctx.agent('planner', { schema: z.object({ steps: z.array(z.string()) }) });
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
import table from './.rocky/workflow.ts';
assert.equal(z.string().parse('ok'), 'ok');
assert.deepEqual(table.map((trigger) => trigger.kind), ['linear.onDelegate', 'manual']);
assert.equal(table[1].name, 'review');
assert.ok(table.every(Object.isFrozen));
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
