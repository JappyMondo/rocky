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
import { chmod, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from './paths.js';
import { ConfigError } from './schema.js';
import {
  ensureInstanceLayout,
  readCredentials,
  readInstanceConfig,
  updateCredentials,
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
  harnesses: { opencode: { command: '/opt/opencode/opencode' } },
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
  it('cancels a held-lock waiter without invoking it later or consuming the next writer lock', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = updateCredentials(paths, async (current) => {
      acquired();
      await holding;
      return current;
    });
    await ready;
    const abort = new AbortController();
    let called = false;
    const waiting = updateCredentials(
      paths,
      () => {
        called = true;
        return credentials;
      },
      { signal: abort.signal },
    );
    const result = waiting.catch((error: unknown) => error);
    try {
      await delay(50);
      abort.abort();
      expect(
        await Promise.race([result, delay(500).then(() => 'still waiting')]),
      ).toMatchObject({ name: 'AbortError' });
      expect(called).toBe(false);
    } finally {
      release();
      await holder;
      await result;
    }
    await updateCredentials(paths, () => credentials, {
      signal: AbortSignal.timeout(500),
    });
    expect(called).toBe(false);
    expect(await readCredentials(paths)).toMatchObject(credentials);
  });

  it('cancels an update callback and never persists its late result', async () => {
    await writeCredentials(paths, credentials);
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = new AbortController();
    const result = updateCredentials(
      paths,
      async (current) => {
        entered();
        await pending;
        return { ...current, linear: { accessToken: 'late-token' } };
      },
      { signal: abort.signal },
    ).catch((error: unknown) => error);
    await ready;
    try {
      abort.abort();
      expect(
        await Promise.race([result, delay(500).then(() => 'still waiting')]),
      ).toMatchObject({ name: 'AbortError' });
      await updateCredentials(
        paths,
        (current) => ({ ...current, linear: { accessToken: 'newer-token' } }),
        { signal: AbortSignal.timeout(500) },
      );
    } finally {
      finish();
      await result;
    }
    await delay(30);
    expect((await readCredentials(paths)).linear?.accessToken).toBe(
      'newer-token',
    );
    expect(
      (await readdir(paths.root)).filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.lock'),
      ),
    ).toEqual([]);
  });
  it('persists a credential update that returns the same object after changing it', async () => {
    await updateCredentials(paths, (current) => {
      current.mcp['https://example.com/mcp'] = { accessToken: 'updated' };
      return current;
    });
    expect((await readCredentials(paths)).mcp).toEqual({
      'https://example.com/mcp': { accessToken: 'updated' },
    });
  });
  it('serializes concurrent credential updates without losing another login', async () => {
    await writeCredentials(paths, credentials);
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        updateCredentials(paths, async (current) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            ...current,
            mcp: {
              ...current.mcp,
              [`https://server-${index}.example/mcp`]: {
                accessToken: `token-${index}`,
              },
            },
          };
        }),
      ),
    );
    expect(Object.keys((await readCredentials(paths)).mcp)).toHaveLength(7);
    expect(await readCredentials(paths)).toMatchObject({
      linear: credentials.linear,
      repos: credentials.repos,
    });
  });

  it('releases the credential lock when an update fails', async () => {
    await expect(
      updateCredentials(paths, () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await updateCredentials(paths, () => credentials);
    expect(await readCredentials(paths)).toMatchObject(credentials);
  });

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
  it.skipIf(!POSIX)(
    'refuses a credential symlink instead of reading or chmodding its target',
    async () => {
      const target = join(root, 'target');
      writeFileSync(target, JSON.stringify(credentials), { mode: 0o644 });
      await symlink(target, paths.credentialsFile);
      await expect(readCredentials(paths)).rejects.toThrow(/regular file/);
      expect(statSync(target).mode & 0o777).toBe(0o644);
    },
  );
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
