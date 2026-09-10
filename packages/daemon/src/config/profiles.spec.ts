import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureInstanceLayout } from './store.js';
import {
  canonicalRemote,
  newRepositoryProfile,
  newSeedRepositoryProfile,
  profileMcpConfig,
  readRepositoryProfile,
  writeRepositoryProfile,
} from './profiles.js';
import { rockyPaths } from './paths.js';

describe('local repository profiles', () => {
  it('accepts a multi-repository profile without a single remote identity', () => {
    const profile = newRepositoryProfile({
      id: 'product',
      repos: [
        { name: 'web', url: 'github.com/acme/web', baseBranch: 'main' },
        {
          name: 'api',
          url: 'git@github.com:acme/api.git',
          baseBranch: 'develop',
        },
      ],
    });
    expect(profile.repos?.[0].url).toBe('https://github.com/acme/web');
    expect(profile.remote).toBe('github.com/acme/web');
  });

  it('rejects empty membership, duplicate folders or remotes, and path traversal', () => {
    const member = {
      name: 'api',
      url: 'https://github.com/acme/api.git',
      baseBranch: 'main',
    };
    for (const repos of [
      [],
      [
        member,
        { ...member, name: 'API', url: 'https://github.com/acme/other' },
      ],
      [
        member,
        { ...member, name: 'other', url: 'git@github.com:acme/api.git' },
      ],
      [{ ...member, name: '../outside' }],
      [{ ...member, name: '..' }],
      [{ ...member, url: 'https://user:password@example.test/repo' }],
      [{ ...member, url: 'https://' }],
    ])
      expect(() => newRepositoryProfile({ id: 'product', repos })).toThrow();
  });

  it('turns the shipped workflow into local-only runnable profile content', async () => {
    const profile = await newSeedRepositoryProfile({
      id: 'api',
      remote: 'https://github.com/acme/api.git',
    });

    expect(profile.workflow.triggers).toEqual([
      'linear.onDelegate',
      'address-pr-conversations',
    ]);
    expect(profile.workflow.source).toContain('linear.onDelegate(main)');
    expect(profile.workflow.source).toContain("harness: 'opencode'");
    expect(profile.grants.harness).toBe('opencode');
    expect(profile.prompts.planner).toBeTruthy();
    expect(profile.schemas).toContain('export');
    expect(profile.mcp).toMatchObject({ mcpServers: {} });
    expect(profile.settings.secretEnv).toContain('GITHUB_TOKEN');
  });

  it('pins the harness and model selected during setup into a new profile', async () => {
    const profile = await newSeedRepositoryProfile({
      id: 'api',
      remote: 'https://github.com/acme/api.git',
      defaults: { harness: 'opencode', model: 'openai/gpt-5.2' },
    });

    expect(profile.grants.harness).toBe('opencode');
    expect(profile.workflow.source).toContain('model: "openai/gpt-5.2"');
  });

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
