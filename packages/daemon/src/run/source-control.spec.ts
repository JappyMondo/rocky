import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { rockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { newRepositoryProfile } from '../config/profiles.js';
import { newRunHeader } from './header.js';
import { currentRunSourceControl } from './source-control.js';

it('reloads auth independently of workflow content, respects profile overrides and does not modify the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-current-git-'));
  try {
    const paths = rockyPaths(root);
    const profile = newRepositoryProfile({
      id: 'app',
      remote: 'https://example.test/app.git',
    });
    profile.sourceControl = {
      git: { email: 'old@example.test', sshAgent: '/old-agent' },
    };
    const run = newRunHeader({
      runId: 'NG-1-1',
      repo: 'app',
      branch: 'branch',
      profile,
      issue: {
        identifier: 'NG-1',
        title: '',
        description: '',
        url: '',
        labels: [],
      },
      now: '2026-09-14T00:00:00Z',
    });
    const config = parseInstanceConfig({
      sourceControl: {
        git: { email: 'new@example.test', sshAgent: '/new-agent' },
        gitlab: { tokenEnv: 'CURRENT_TOKEN' },
      },
    });
    await mkdir(paths.profilesDir, { recursive: true });
    await writeFile(
      paths.profile('app'),
      JSON.stringify({
        workflow: 'unfinished edit',
        sourceControl: { git: { signCommits: false, sshAgent: null } },
      }),
    );
    expect(await currentRunSourceControl(paths, config, run)).toMatchObject({
      git: { email: 'new@example.test', sshAgent: null, signCommits: false },
      gitlab: { tokenEnv: 'CURRENT_TOKEN' },
    });
    config.sourceControl = { git: { email: 'changed-again@example.test' } };
    expect((await currentRunSourceControl(paths, config, run)).git?.email).toBe(
      'changed-again@example.test',
    );
    expect(run.profile?.sourceControl?.git?.email).toBe('old@example.test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
