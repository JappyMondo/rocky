import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlow } from '@rocky/local-contracts';
import type { RockyPaths } from '../config/paths.js';
import type { RunHeader } from './header.js';

/** Only packaged delivery flows understand durable review continuation grants. */
export async function reviewContinuationRounds(
  paths: RockyPaths,
  run: RunHeader,
): Promise<number | undefined> {
  if (run.artifactsPruned || !run.execution) return;
  try {
    const flow = parseFlow(
      await readFile(
        join(paths.run(run.runId).snapshotDir, 'workflow.json'),
        'utf8',
      ),
    );
    if (
      flow.nodes.some((node) =>
        [
          'delivery.compliance',
          'delivery.review',
          'delivery.ui',
          'delivery.validate',
          'delivery.ci',
          'delivery.deliverable',
        ].includes(node.type),
      )
    )
      return flow.settings.reviewCap;
  } catch {
    // Legacy/missing snapshots cannot interpret this continuation protocol.
  }
  return undefined;
}
