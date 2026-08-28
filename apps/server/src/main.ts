import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import {
  DeployConfigError,
  formatDeployConfigError,
  loadDeployConfig,
} from './config/deploy-config';
import type { DeployConfig } from './config/deploy-config';
import { nestLogLevels } from './config/logging';

async function main(): Promise<void> {
  // Deploy config and logging come first. Logging has to work before anything
  // else opens, including the database, or a failure to open the database has
  // nowhere to report itself.
  const config = loadConfigOrExit();
  Logger.overrideLogger(nestLogLevels(config.logLevel));

  const app = await createApp(config);
  await app.listen({ port: config.port, host: '0.0.0.0' });

  new Logger('Bootstrap').log(
    `Rocky is listening on port ${config.port}, reachable at ${config.baseUrl}`,
  );
}

function loadConfigOrExit(): DeployConfig {
  try {
    return loadDeployConfig(process.env);
  } catch (error) {
    if (error instanceof DeployConfigError) {
      // The logger is not configured yet, and this is the one message an
      // operator needs to read, so it goes straight to stderr.
      process.stderr.write(`${formatDeployConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

main();
