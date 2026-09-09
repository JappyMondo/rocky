import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import { IntakeFailures } from './intake-failures.js';

describe('post-acknowledgement intake failures', () => {
  it('persists only safe diagnostic fields and replaces a stale session record', async () => {
    const paths = rockyPaths(await mkdtemp(join(tmpdir(), 'rocky-intake-')));
    const failures = new IntakeFailures(paths);
    const event = {
      action: 'created' as const,
      sessionId: 'session-1',
      appUserId: 'app-user',
      organizationId: 'workspace',
      payload: { prompt: 'never persist this' },
    };

    await failures.record(event);
    await failures.record({ ...event, action: 'prompted' });

    await expect(failures.list()).resolves.toMatchObject([
      {
        sessionId: 'session-1',
        action: 'prompted',
        reason: expect.stringContaining('could not admit'),
      },
    ]);
    expect(await readFile(paths.intakeFailuresFile, 'utf8')).not.toContain(
      'never persist this',
    );
  });
});
