/**
 * AC2: editing a repo entry while the daemon runs applies to the next Run
 * without a restart; editing bind/port prints the restart hint.
 *
 * This is the Cyrus lesson NG-578 set out to fix directly — no hot reload
 * there meant every config edit cost a restart, which meant edits got batched
 * and `.bak` files piled up.
 *
 * Tests that assert on one specific reload open the store with the watcher
 * off and drive `reload()` themselves; the two that are about the watcher
 * itself let it run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openConfigStore, type ConfigStore } from './watcher.js';
import { rockyPaths, type RockyPaths } from './paths.js';
import { route } from './routing.js';

let root: string;
let paths: RockyPaths;
let store: ConfigStore | undefined;
let warnings: string[];

function writeConfig(config: unknown): void {
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2));
}

const repo = (name: string, label: string) => ({
  name,
  url: `git@github.com:digimondo/${name}.git`,
  baseBranch: 'main',
  label,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-watch-'));
  paths = rockyPaths(root);
  warnings = [];
});

afterEach(async () => {
  await store?.close();
  store = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function open(watch = false): Promise<ConfigStore> {
  store = await openConfigStore(paths, {
    watch,
    warn: (message) => warnings.push(message),
  });
  return store;
}

describe('a repo entry edited while the daemon runs', () => {
  it('reaches the next lookup without a restart', async () => {
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open(true);

    expect(route(opened.current, { labels: ['rocky-api'] }).kind).toBe(
      'refusal',
    );

    const reloaded = opened.nextReload();
    writeConfig({
      repos: [repo('niotix', 'rocky'), repo('niota-api', 'rocky-api')],
    });
    await reloaded;

    expect(route(opened.current, { labels: ['rocky-api'] })).toMatchObject({
      kind: 'repo',
      repo: { name: 'niota-api' },
    });
  });

  it('applies to new Runs only, because a Run holds the config it started on', async () => {
    // Snapshot semantics: nothing takes the config away from a live Run.
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open();
    const takenAtRunStart = opened.current;

    writeConfig({ repos: [repo('niotix', 'rocky-renamed')] });
    await opened.reload();

    expect(takenAtRunStart.repos[0].label).toBe('rocky');
    expect(opened.current.repos[0].label).toBe('rocky-renamed');
  });
});

describe('bind and port', () => {
  it('keep serving on what was bound, and say what it takes to move', async () => {
    writeConfig({ server: { host: '127.0.0.1', port: 7625 } });
    const opened = await open();

    writeConfig({ server: { host: '0.0.0.0', port: 7999 } });
    const report = await opened.reload();

    expect(report.restartRequired).toEqual(['host', 'port']);
    expect(report.restartHint).toMatch(/rocky restart/);
    expect(warnings.join('\n')).toMatch(/rocky restart/);

    // The daemon is still on the socket it opened, whatever the file says.
    expect(opened.boundServer).toEqual({ host: '127.0.0.1', port: 7625 });
  });

  it('name only the field that actually moved', async () => {
    writeConfig({ server: { host: '127.0.0.1', port: 7625 } });
    const opened = await open();

    writeConfig({ server: { host: '127.0.0.1', port: 7999 } });

    expect((await opened.reload()).restartRequired).toEqual(['port']);
  });

  it('say nothing when a reload leaves them where they were', async () => {
    writeConfig({ server: { port: 7625 }, repos: [repo('niotix', 'rocky')] });
    const opened = await open();

    writeConfig({
      server: { port: 7625 },
      repos: [repo('niotix', 'moved-label')],
    });
    const report = await opened.reload();

    expect(report.restartRequired).toEqual([]);
    expect(report.restartHint).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('a reload that cannot be used', () => {
  it('keeps the last good config rather than leaving the daemon with none', async () => {
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open();

    writeFileSync(paths.configFile, '{ this is not json');

    await expect(opened.reload()).rejects.toThrow(/config\.json/);

    expect(opened.current.repos[0].name).toBe('niotix');
    expect(route(opened.current, { labels: ['rocky'] }).kind).toBe('repo');
  });

  it('reports a schema failure through the watcher rather than throwing into it', async () => {
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open(true);

    const failed = new Promise<unknown>((resolve) => opened.onError(resolve));
    writeConfig({ repos: [{ name: 'niotix', url: 'u' }] });

    expect(String(await failed)).toMatch(/config\.json/);
    expect(opened.current.repos[0].label).toBe('rocky');
  });
});

describe('credentials', () => {
  it('are re-read on demand rather than cached at boot', async () => {
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open();

    expect((await opened.readCredentials()).linear).toBeUndefined();

    writeFileSync(
      paths.credentialsFile,
      JSON.stringify({ linear: { accessToken: 'lin_new' } }),
      { mode: 0o600 },
    );

    expect((await opened.readCredentials()).linear?.accessToken).toBe(
      'lin_new',
    );
  });

  it('join the redaction set as soon as they are read', async () => {
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open();
    const redact = opened.redact;

    writeFileSync(
      paths.credentialsFile,
      JSON.stringify({ linear: { accessToken: 'lin_new' } }),
      { mode: 0o600 },
    );
    await opened.readCredentials();

    expect(redact('Authorization: Bearer lin_new')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });
});

describe('the redactor', () => {
  it('is one stable function, so a log stream opened at boot stays correct', async () => {
    // The daemon wires this into its log destination once, at boot. If a
    // reload handed back a new function, every secret added later would leak.
    writeConfig({ repos: [repo('niotix', 'rocky')] });
    const opened = await open();
    const redact = opened.redact;

    expect(redact('token=planted_later')).toBe('token=planted_later');

    writeConfig({
      repos: [repo('niotix', 'rocky')],
      harnesses: { 'claude-code': { env: { API_KEY: 'planted_later' } } },
    });
    await opened.reload();

    expect(redact('token=planted_later')).toBe('token=[redacted]');
  });
});
