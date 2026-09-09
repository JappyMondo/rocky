import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { rockyPaths } from '../config/paths.js';
import type { AgentSessionEvent } from './events.js';
import { IntakeFailures } from './intake-failures.js';

describe('post-acknowledgement intake failures', () => {
  it('persists only safe diagnostic fields and replaces a stale session record', async () => {
    const paths = rockyPaths(await mkdtemp(join(tmpdir(), 'rocky-intake-')));
    const failures = new IntakeFailures(paths);
    const event: AgentSessionEvent = {
      action: 'created',
      sessionId: 'session-1',
      appUserId: 'app-user',
      organizationId: 'workspace',
      // The payload's real shape is intentionally irrelevant here. This
      // request text comes from it and must never reach durable diagnostics.
      promptContext: 'never persist this',
      payload: {} as AgentSessionEvent['payload'],
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
