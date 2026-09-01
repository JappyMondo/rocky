import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The daemon's own version, as published. The CLI compares its version against
 * this on every API call (NG-578) — so it has to come from the artifact that is
 * actually running, not from a constant someone can forget to bump.
 */
export const DAEMON_VERSION: string = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

/** Sent on every response; the CLI reads it to detect a mismatch. */
export const VERSION_HEADER = 'x-rocky-version';

/** Sent by the CLI on every request, so the daemon can log a stale client. */
export const CLIENT_VERSION_HEADER = 'x-rocky-client-version';
