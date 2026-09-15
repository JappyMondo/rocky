import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import {
  newRepositoryProfile,
  writeRepositoryProfile,
} from '../config/profiles.js';
import { newRunHeader, readRunHeader, writeRunHeader } from './header.js';
import { currentRunModels } from './current-models.js';

const workflow = [
  'export const models = { review: { name: "Review" } };',
  'export default [];',
].join('\n');

it('uses the latest complete selections and ignores historical header selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-current-models-'));
  try {
    const paths = rockyPaths(root);
    const profile = {
      ...newRepositoryProfile({
        id: 'app',
        remote: 'https://example.test/app.git',
      }),
      workflow: { source: workflow, triggers: [] },
      models: {
        review: {
          harness: 'opencode' as const,
          model: 'openai/gpt-5.6-terra',
          effort: 'medium',
        },
      },
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
      now: '2026-09-15T00:00:00.000Z',
    });
    expect(run.profile?.models).toBeUndefined();
    if (!run.profile) throw new Error('Missing profile');
    // A Run created by a prior Rocky release can still contain these fields.
    run.profile.models = {
      review: {
        harness: 'opencode',
        model: 'openai/stale-model',
        effort: 'low',
      },
    };
    await writeRunHeader(paths, run);
    const historicalRun = await readRunHeader(paths, run.runId);
    expect(historicalRun.profile?.models?.review.model).toBe(
      'openai/stale-model',
    );

    await writeRepositoryProfile(paths, profile);
    expect(await currentRunModels(paths, historicalRun)).toEqual(
      profile.models,
    );

    const latest = {
      ...profile,
      models: {
        review: {
          harness: 'claude-code' as const,
          model: 'claude-latest',
          effort: 'high',
        },
      },
    };
    await writeRepositoryProfile(paths, latest);

    expect(await currentRunModels(paths, historicalRun)).toEqual(latest.models);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
