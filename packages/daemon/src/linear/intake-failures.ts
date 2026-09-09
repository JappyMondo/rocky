import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import type { RockyPaths } from '../config/paths.js';
import type { AgentSessionEvent } from './events.js';

const failureSchema = z.strictObject({
  sessionId: z.string().min(1),
  action: z.enum(['created', 'prompted']),
  occurredAt: z.string().datetime(),
  reason: z.string().min(1).max(500),
  remediation: z.string().min(1).max(500),
});
const failuresSchema = z.array(failureSchema).max(100);

export type IntakeFailure = z.infer<typeof failureSchema>;

/**
 * Deliberately records only a stable, operator-safe failure shape. Raw webhook
 * content and thrown errors can contain user prompts or credentials and never
 * belong in an API response or durable diagnostic file.
 */
export class IntakeFailures {
  constructor(private readonly paths: RockyPaths) {}

  async list(): Promise<IntakeFailure[]> {
    try {
      return failuresSchema.parse(
        JSON.parse(await readFile(this.paths.intakeFailuresFile, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async record(event: AgentSessionEvent): Promise<void> {
    const current = await this.list();
    const failure: IntakeFailure = {
      sessionId: event.sessionId,
      action: event.action,
      occurredAt: new Date().toISOString(),
      reason:
        'Rocky acknowledged this Linear delivery but could not admit or control its Run.',
      remediation:
        'Open Rocky locally, inspect this intake failure, then recover the session or delegate the issue again.',
    };
    await writeAtomic(
      this.paths.intakeFailuresFile,
      serializeJson(
        [
          ...current.filter((item) => item.sessionId !== failure.sessionId),
          failure,
        ].slice(-100),
      ),
      PUBLIC_MODE,
    );
  }
}
