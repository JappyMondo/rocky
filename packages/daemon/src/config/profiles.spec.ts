import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureInstanceLayout } from './store.js';
import {
  canonicalRemote,
  newRepositoryProfile,
  profileMcpConfig,
  readRepositoryProfile,
  writeRepositoryProfile,
} from './profiles.js';
import { rockyPaths } from './paths.js';

describe('local repository profiles', () => {
  it('stores a pipeline locally and never needs a checkout path', async () => {
    const paths = rockyPaths(await mkdtemp(join(tmpdir(), 'rocky-profile-')));
    await ensureInstanceLayout(paths);
    const profile = newRepositoryProfile({
      id: 'api',
      remote: 'git@github.com:Acme/API.git',
    });
    await writeRepositoryProfile(paths, {
      ...profile,
      mcp: {
        mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test' } },
      },
      settings: { env: { NODE_ENV: 'test' }, secretEnv: ['API_TOKEN'] },
    });

    const loaded = await readRepositoryProfile(paths, 'api');
    expect(loaded.remote).toBe('github.com/acme/api');
    expect(
      profileMcpConfig(loaded, paths.profile('api')).mcpServers.docs,
    ).toBeDefined();
    expect(await readFile(paths.profile('api'), 'utf8')).not.toContain(
      'API_TOKEN=',
    );
  });

  it('normalizes equivalent SSH and HTTPS identities', () => {
    expect(canonicalRemote('git@github.com:Acme/API.git')).toBe(
      canonicalRemote('https://github.com/acme/api.git'),
    );
  });
});
