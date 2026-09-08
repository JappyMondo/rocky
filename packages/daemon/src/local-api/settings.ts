import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  McpStatus,
  SettingsValues,
  SettingsView,
} from '@rocky/local-contracts';
import { z } from 'zod';

import { PUBLIC_MODE, serializeJson, writeAtomic } from '../atomic-write.js';
import type { RockyPaths } from '../config/paths.js';
import { parseInstanceConfig } from '../config/schema.js';
import { KeyedMutex } from '../repos/mutex.js';

export class LocalApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

const settingsPatch = z
  .object({
    revision: z.string(),
    patch: z
      .object({
        server: z
          .object({
            host: z.enum(['127.0.0.1', 'localhost', '::1']).optional(),
            port: z.number().int().min(1).max(65535).optional(),
          })
          .strict()
          .optional(),
        retention: z
          .object({
            keepTerminalRuns: z.number().int().min(1).optional(),
            keepSessionsAndScreenshots: z.number().int().min(1).optional(),
          })
          .strict()
          .optional(),
        concurrency: z
          .object({ maxRuns: z.number().int().min(1).optional() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const updates = new KeyedMutex();

/** Only these fields may cross the local settings boundary; never spread config. */
function values(
  config: ReturnType<typeof parseInstanceConfig>,
): SettingsValues {
  return {
    server: { host: config.server.host, port: config.server.port },
    retention: {
      keepTerminalRuns: config.retention.keepTerminalRuns,
      keepSessionsAndScreenshots: config.retention.keepSessionsAndScreenshots,
    },
    concurrency: { maxRuns: config.concurrency.maxRuns },
  };
}

export class LocalSettings {
  constructor(
    private readonly options: {
      paths: RockyPaths;
      boundServer: SettingsValues['server'];
      mcpStatus?: () => Promise<McpStatus[]>;
      /** Composition hot-reloads retention/cap through its existing config watcher. */
    },
  ) {}

  private async current() {
    const text = await readFile(this.options.paths.configFile, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '{}';
        throw error;
      },
    );
    return {
      config: parseInstanceConfig(JSON.parse(text)),
      revision: createHash('sha256').update(text).digest('hex'),
    };
  }

  async read(): Promise<SettingsView> {
    const { config, revision } = await this.current();
    const configured = values(config);
    return {
      values: configured,
      revision,
      restartRequired:
        configured.server.host !== this.options.boundServer.host ||
        configured.server.port !== this.options.boundServer.port,
      mcpAvailable: this.options.mcpStatus !== undefined,
      mcp: ((await this.options.mcpStatus?.()) ?? []).map(
        ({ name, status, loginCommand }) => ({ name, status, loginCommand }),
      ),
    };
  }

  async patch(input: unknown): Promise<SettingsView> {
    const parsed = settingsPatch.safeParse(input);
    if (!parsed.success)
      throw new LocalApiError(
        400,
        'invalid-settings',
        'Invalid settings. Use positive integer limits and a loopback bind address.',
      );
    return updates.run(this.options.paths.configFile, async () => {
      const { config, revision } = await this.current();
      if (revision !== parsed.data.revision)
        throw new LocalApiError(
          409,
          'settings-changed',
          'Settings changed. Reload before saving; your edits have not been applied.',
        );
      const patch = parsed.data.patch;
      let merged: ReturnType<typeof parseInstanceConfig>;
      try {
        merged = parseInstanceConfig({
          ...config,
          server: { ...config.server, ...patch.server },
          retention: { ...config.retention, ...patch.retention },
          concurrency: { ...config.concurrency, ...patch.concurrency },
        });
      } catch {
        throw new LocalApiError(
          400,
          'invalid-settings',
          'Artifact retention cannot exceed terminal Run retention.',
        );
      }
      if ((await this.current()).revision !== revision)
        throw new LocalApiError(
          409,
          'settings-changed',
          'Settings changed while saving. Reload before retrying.',
        );
      await writeAtomic(
        this.options.paths.configFile,
        serializeJson(merged),
        PUBLIC_MODE,
      );
      return this.read();
    });
  }
}
