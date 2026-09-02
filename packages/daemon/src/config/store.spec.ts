/**
 * AC1: both files round-trip through a typed loader; `credentials.json` is
 * created 0600 and a wrong mode is fixed or warned at boot.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from './paths.js';
import { ConfigError } from './schema.js';
import {
  ensureInstanceLayout,
  readCredentials,
  readInstanceConfig,
  writeCredentials,
  writeInstanceConfig,
} from './store.js';

const POSIX = process.platform !== 'win32';

let root: string;
let paths: RockyPaths;
let warnings: string[];
const warn = (message: string) => warnings.push(message);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-home-'));
  paths = rockyPaths(root);
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const config = {
  publicUrl: 'https://rocky.dev.example.com',
  server: { host: '0.0.0.0', port: 7626 },
  retention: { keepTerminalRuns: 50, keepSessionsAndScreenshots: 20 },
  repos: [
    {
      name: 'niotix',
      url: 'git@github.com:digimondo/niotix.git',
      baseBranch: 'main',
      label: 'rocky',
      teams: ['Niotix Grid'],
      env: { NODE_ENV: 'test' },
    },
    { name: 'niota-api', url: 'b', baseBranch: 'main', label: 'rocky-api' },
  ],
  groups: [
    {
      name: 'platform',
      label: 'rocky-platform',
      repos: ['niotix', 'niota-api'],
      workflow: 'niotix',
    },
  ],
  harnesses: { 'claude-code': { command: '/opt/claude/claude' } },
};

const credentials = {
  linear: { accessToken: 'lin_oauth_xxx', webhookSecret: 'whsec_xxx' },
  repos: { niotix: { NPM_TOKEN: 'npm_xxx' } },
  mcp: { 'https://mcp.linear.app/sse': { refreshToken: 'r' } },
};

describe('a machine with nothing written yet', () => {
  it('boots on defaults rather than failing', async () => {
    expect(await readInstanceConfig(paths)).toMatchObject({
      repos: [],
      groups: [],
      server: { host: '127.0.0.1', port: 7625 },
    });
    expect(await readCredentials(paths, { warn })).toEqual({
      repos: {},
      mcp: {},
    });
  });

  it('gets the layout NG-578 describes', async () => {
    await ensureInstanceLayout(paths);

    for (const dir of [
      paths.root,
      paths.logsDir,
      paths.reposDir,
      paths.runsDir,
    ]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  it.skipIf(!POSIX)(
    'keeps the root private, since credentials live in it',
    async () => {
      await ensureInstanceLayout(paths);

      expect(statSync(paths.root).mode & 0o777).toBe(0o700);
    },
  );
});

describe('round-tripping', () => {
  it('returns config.json exactly as it went in', async () => {
    await writeInstanceConfig(paths, config);

    expect(await readInstanceConfig(paths)).toMatchObject(config);
  });

  it('returns credentials.json exactly as it went in', async () => {
    await writeCredentials(paths, credentials);

    expect(await readCredentials(paths, { warn })).toMatchObject(credentials);
  });

  it('writes config.json as something a human can edit', async () => {
    await writeInstanceConfig(paths, config);

    const text = await readFile(paths.configFile, 'utf8');
    expect(text).toContain('\n  "repos": [');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('leaves no temp file behind, so a crash mid-write cannot be read', async () => {
    await writeInstanceConfig(paths, config);
    await writeCredentials(paths, credentials);

    expect(await readdir(paths.root)).toEqual(
      expect.arrayContaining(['config.json', 'credentials.json']),
    );
    expect(
      (await readdir(paths.root)).filter((f) => f.includes('tmp')),
    ).toEqual([]);
  });
});

describe('the mode on credentials.json', () => {
  it.skipIf(!POSIX)('is 0600 the moment Rocky creates it', async () => {
    await writeCredentials(paths, credentials);

    expect(statSync(paths.credentialsFile).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)(
    'is fixed, and said out loud, when it is wrong at boot',
    async () => {
      await writeCredentials(paths, credentials);
      await chmod(paths.credentialsFile, 0o644);

      await readCredentials(paths, { warn });

      expect(statSync(paths.credentialsFile).mode & 0o777).toBe(0o600);
      expect(warnings.join('\n')).toMatch(/credentials\.json.*0644.*0600/s);
    },
  );

  it.skipIf(!POSIX)(
    'is left alone, and unremarked, when it is already right',
    async () => {
      await writeCredentials(paths, credentials);

      await readCredentials(paths, { warn });

      expect(warnings).toEqual([]);
    },
  );

  it.skipIf(!POSIX)('never leaks through the temp file mid-write', async () => {
    // The atomic write must create the temp file 0600 too — a rename keeps the
    // temp file's mode, and a world-readable temp file is the same leak.
    await writeCredentials(paths, credentials);
    await writeCredentials(paths, { ...credentials, repos: {} });

    expect(statSync(paths.credentialsFile).mode & 0o777).toBe(0o600);
  });
});

describe('a file a human broke', () => {
  beforeEach(() => {
    mkdirSync(paths.root, { recursive: true });
  });

  it('names the file when the JSON will not parse', async () => {
    writeFileSync(paths.configFile, '{ "repos": [ }');

    await expect(readInstanceConfig(paths)).rejects.toThrow(ConfigError);
    await expect(readInstanceConfig(paths)).rejects.toThrow(/config\.json/);
  });

  it('keeps the locator, which is the half of the message worth having', async () => {
    writeFileSync(paths.credentialsFile, '{\n  "linear": {,\n}\n', {
      mode: 0o600,
    });

    await expect(readCredentials(paths, { warn })).rejects.toThrow(
      /position|line/i,
    );
  });

  it('names the file and the field when the shape is wrong', async () => {
    writeFileSync(
      paths.configFile,
      JSON.stringify({ repos: [{ name: 'niotix', url: 'u' }] }),
    );

    await expect(readInstanceConfig(paths)).rejects.toThrow(
      /config\.json[\s\S]*baseBranch/,
    );
  });

  it('names credentials.json too, without quoting what is inside it', async () => {
    writeFileSync(paths.credentialsFile, 'not json at all', { mode: 0o600 });

    await expect(readCredentials(paths, { warn })).rejects.toThrow(
      /credentials\.json/,
    );
    await expect(readCredentials(paths, { warn })).rejects.not.toThrow(
      /not json at all/,
    );
  });
});
