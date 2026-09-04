/**
 * Cloning repos that appear in `config.json` (NG-521, NG-578).
 *
 * `rocky repo add` clones eagerly, at the terminal, with a human present. The
 * other way a repo entry can appear is a hand-edit picked up by the config
 * watcher — nobody is watching the terminal then, so the daemon does the clone
 * itself and the outcome has to be reportable rather than thrown away.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'; // prettier-ignore

import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { ensureInstanceLayout } from '../config/store.js';
import { openConfigStore, type ConfigStore } from '../config/watcher.js';
import { KeyedMutex } from './mutex.js';
import { followConfigReloads, reconcileClones, type ReconcileReport } from './reconcile.js'; // prettier-ignore
import { createUpstream, makeTempDir, type Upstream } from './upstream.fixtures.js'; // prettier-ignore
import type { RepoContext } from './context.js';

const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  process.env = savedEnv;
});

let home: string;
let paths: RockyPaths;
let ctx: RepoContext;
let upstream: Upstream;
let sibling: Upstream;
let store: ConfigStore | undefined;

beforeEach(async () => {
  home = makeTempDir('home');
  paths = rockyPaths(home);
  await ensureInstanceLayout(paths);
  ctx = {
    paths,
    mutex: new KeyedMutex(),
    identity: { name: 'Rocky', email: 'rocky@rocky.invalid' },
  };
  upstream = await createUpstream();
  sibling = await createUpstream();
});

afterEach(async () => {
  await store?.close();
  store = undefined;
  for (const dir of [
    home,
    upstream.dir,
    upstream.workingCopy,
    sibling.dir,
    sibling.workingCopy,
  ]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const entry = (name: string, url: string, label = name) => ({
  name,
  url,
  baseBranch: 'main',
  label,
});

function writeConfig(config: unknown): void {
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2));
}

describe('reconciling the configured repos', () => {
  it('clones the ones Rocky does not have yet', async () => {
    const report = await reconcileClones(ctx, [
      entry('niotix', upstream.url),
      entry('niota-api', sibling.url),
    ]);

    expect(report.cloned.sort()).toEqual(['niota-api', 'niotix']);
    expect(report.updated).toEqual([]);
    expect(existsSync(paths.repo('niotix'))).toBe(true);
    expect(existsSync(paths.repo('niota-api'))).toBe(true);
  });

  it('fetches the ones it already has, rather than reporting them as new', async () => {
    await reconcileClones(ctx, [entry('niotix', upstream.url)]);

    const report = await reconcileClones(ctx, [entry('niotix', upstream.url)]);

    expect(report.cloned).toEqual([]);
    expect(report.updated).toEqual(['niotix']);
  });

  it('reports a repo it could not clone and keeps going with the rest', async () => {
    const report = await reconcileClones(ctx, [
      entry('broken', join(makeTempDir('gone'), 'nope.git')),
      entry('niotix', upstream.url),
    ]);

    // One bad url in a hand-edited file must not cost the other repos their
    // clone — the daemon has no human at a terminal to re-run it.
    expect(report.cloned).toEqual(['niotix']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].repo).toBe('broken');
    expect(report.failures[0].message).toMatch(/ls-remote/);
  });

  it('says nothing for a config with no repos in it', async () => {
    await expect(reconcileClones(ctx, [])).resolves.toEqual({
      cloned: [],
      updated: [],
      failures: [],
    });
  });
});

describe('following the config watcher', () => {
  it('clones a repo a hand-edit added, without a restart', async () => {
    writeConfig({ repos: [entry('niotix', upstream.url)] });
    await reconcileClones(ctx, [entry('niotix', upstream.url)]);
    store = await openConfigStore(paths, {
      watch: true,
      warn: () => undefined,
    });

    const reports: ReconcileReport[] = [];
    const follower = followConfigReloads(ctx, store, {
      onReport: (report) => reports.push(report),
    });

    try {
      writeConfig({
        repos: [entry('niotix', upstream.url), entry('niota-api', sibling.url)],
      });

      // The report, not the directory: the directory exists part-way through
      // the clone, so waiting on it would race the report that follows.
      await waitFor(() => reports.length > 0);
      // Only the new one is `cloned`; the one that was already there is
      // `updated`, so a human reading `rocky status` can tell what happened.
      expect(reports).toContainEqual({
        cloned: ['niota-api'],
        updated: ['niotix'],
        failures: [],
      });
      expect(existsSync(paths.repo('niota-api'))).toBe(true);
    } finally {
      follower.close();
    }
  });

  it('stops once it is closed', async () => {
    writeConfig({ repos: [] });
    store = await openConfigStore(paths, {
      watch: true,
      warn: () => undefined,
    });

    const reports: ReconcileReport[] = [];
    const follower = followConfigReloads(ctx, store, {
      onReport: (report) => reports.push(report),
    });
    follower.close();

    writeConfig({ repos: [entry('niotix', upstream.url)] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(reports).toEqual([]);
    expect(existsSync(paths.repo('niotix'))).toBe(false);
  });
});

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
