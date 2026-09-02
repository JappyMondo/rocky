/**
 * AC5, end to end: "a secret value planted in config/credentials never appears
 * in daemon logs — a test greps for it."
 *
 * The unit-level rules live in `redaction.spec.ts`. This one plants secrets in
 * real files under a real `~/.rocky`, runs a real daemon whose log goes to
 * `logs/daemon.log`, provokes it into logging them, and then greps the file on
 * disk — which is the artifact the claim is actually about.
 */
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rockyPaths, type RockyPaths } from './paths.js';
import { redactingStream, type Redactor } from './redaction.js';
import { writeCredentials, writeInstanceConfig } from './store.js';
import { openConfigStore, type ConfigStore } from './watcher.js';
import { startDaemon, type RunningDaemon } from '../server.js';

/** Distinctive enough that a grep hit is unambiguous. */
const IN_CREDENTIALS = 'lin_oauth_PLANTED_IN_CREDENTIALS';
const IN_REPO_SECRETS = 'npm_PLANTED_IN_REPO_SECTION';
const IN_CONFIG_UNDER_SECRET_KEY = 'sk_PLANTED_UNDER_A_TOKEN_KEY';
/** Not a secret: the log has to stay worth reading. */
const IN_CONFIG_PLAINLY = 'niotix';

let root: string;
let paths: RockyPaths;
let store: ConfigStore | undefined;
let daemon: RunningDaemon | undefined;
let redact: Redactor;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rocky-log-'));
  paths = rockyPaths(root);

  await writeInstanceConfig(paths, {
    repos: [
      {
        name: IN_CONFIG_PLAINLY,
        url: 'git@github.com:digimondo/niotix.git',
        baseBranch: 'main',
        label: 'rocky',
        env: { API_TOKEN: IN_CONFIG_UNDER_SECRET_KEY, LOG_LEVEL: 'debug' },
      },
    ],
  });
  await writeCredentials(paths, {
    linear: { accessToken: IN_CREDENTIALS },
    repos: { [IN_CONFIG_PLAINLY]: { NPM_TOKEN: IN_REPO_SECRETS } },
  });

  store = await openConfigStore(paths, { watch: false });
  // The redaction set covers credentials only once they have been read, and
  // the daemon reads them at boot.
  await store.readCredentials();
  redact = store.redact;
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await store?.close();
  store = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('the daemon log', () => {
  it('never carries a planted secret, however it got into the line', async () => {
    const file = createWriteStream(paths.daemonLog, { flags: 'a' });
    const log = redactingStream(file, redact);
    daemon = await startDaemon({
      port: 0,
      webRoot: false,
      logger: { level: 'info', stream: log },
    });

    // Fastify logs the request line, so a secret in the URL reaches the log
    // the same way one in a message would.
    await fetch(
      `${daemon.url}/api/health?token=${IN_CONFIG_UNDER_SECRET_KEY}&a=${IN_CREDENTIALS}`,
    );
    daemon.log.info(
      `repo ${IN_CONFIG_PLAINLY} would use ${IN_REPO_SECRETS} and ${IN_CREDENTIALS}`,
    );

    await daemon.close();
    daemon = undefined;
    // Ending the wrapper flushes it and ends the file under it, so everything
    // pino handed over is on disk before the grep.
    await new Promise<void>((resolve) => log.end(resolve));
    await new Promise<void>((resolve) => file.on('close', resolve));

    const written = await readFile(paths.daemonLog, 'utf8');

    expect(written).not.toContain(IN_CREDENTIALS);
    expect(written).not.toContain(IN_REPO_SECRETS);
    expect(written).not.toContain(IN_CONFIG_UNDER_SECRET_KEY);
    expect(written).toContain('[redacted]');
    // A log that redacted the repo name too would be no use to anybody.
    expect(written).toContain(IN_CONFIG_PLAINLY);
  });
});
