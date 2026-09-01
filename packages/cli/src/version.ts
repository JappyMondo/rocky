import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The CLI's own version, read from the artifact that is actually running. */
export const CLI_VERSION: string = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;
