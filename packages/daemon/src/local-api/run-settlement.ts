import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunSummary } from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import { PUBLIC_MODE, writeAtomic } from '../atomic-write.js';

const receipt = z.object({
  settledAt: z.string().datetime(),
  boots: z.number(),
  endedAt: z.string().optional(),
});
type Run = Pick<RunSummary, 'runId' | 'status' | 'boots' | 'endedAt'>;
export const canSettle = (run: Run) =>
  ['finished', 'failed', 'cancelled'].includes(run.status);

/** Presentation metadata is independent of journals and scheduler-owned headers. */
export class RunSettlement {
  constructor(private readonly paths: RockyPaths) {}
  private path(run: Run) {
    return join(this.paths.run(run.runId).dir, 'settlement.json');
  }
  async read(run: Run): Promise<string | undefined> {
    if (!canSettle(run)) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.path(run), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const value = receipt.safeParse(JSON.parse(raw));
    // Resuming a settled run makes any new outcome visible again.
    return value.success &&
      value.data.boots === run.boots &&
      value.data.endedAt === run.endedAt
      ? value.data.settledAt
      : undefined;
  }
  async write(run: Run, settled: boolean) {
    const settledAt = settled
      ? ((await this.read(run)) ?? new Date().toISOString())
      : undefined;
    await writeAtomic(
      this.path(run),
      JSON.stringify(
        settledAt ? { settledAt, boots: run.boots, endedAt: run.endedAt } : {},
      ),
      PUBLIC_MODE,
    );
    return settledAt;
  }
}
