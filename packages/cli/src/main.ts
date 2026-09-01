#!/usr/bin/env node
import { CommanderError } from 'commander';

import { buildCli } from './cli.js';

try {
  await buildCli().parseAsync(process.argv);
} catch (error) {
  // `--help` and `--version` reach here because commander's exit is overridden.
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
