/**
 * AC4: "`rocky doctor` reports endpoint, config and harness-auth status with
 * actionable messages, and exits non-zero when any check fails."
 *
 * The exit code is the CLI's to set; what is asserted here is the material it
 * sets it from — every check's verdict and, on a failure, the sentence that
 * tells the developer what to do about it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { anyFailed, runDoctor, type DoctorOptions } from './doctor.js';
import { rockyPaths, type RockyPaths } from '../config/paths.js';
import { writeInstanceConfig } from '../config/store.js';

let root: string;
let paths: RockyPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rocky-doctor-'));
  paths = rockyPaths(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Nothing here should touch the network or a real harness binary. */
const OFFLINE: DoctorOptions = {
  fetch: () => Promise.reject(new Error('the endpoint was not reached')),
  checkHarness: (harness) =>
    Promise.resolve({ harness, ok: true, detail: 'signed in' }),
};

const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) => {
  const found = report.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(
      `no "${name}" check in ${report.map((e) => e.name).join(', ')}`,
    );
  }
  return found;
};

describe('the config check', () => {
  it('passes on a config that parses', async () => {
    await writeInstanceConfig(paths, {
      repos: [
        {
          name: 'niotix',
          url: 'git@github.com:digimondo/niotix.git',
          baseBranch: 'main',
          label: 'rocky',
        },
      ],
    });

    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'config.json').ok).toBe(true);
  });

  it('passes on a machine with no config at all — the defaults are valid', async () => {
    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'config.json').ok).toBe(true);
  });

  it('fails naming what is wrong, not merely that something is', async () => {
    await writeFile(
      paths.configFile,
      JSON.stringify({
        repos: [
          { name: 'a', url: 'u', baseBranch: 'main', label: 'same' },
          { name: 'b', url: 'u', baseBranch: 'main', label: 'same' },
        ],
      }),
    );

    const report = await runDoctor(paths, OFFLINE);
    const config = check(report, 'config.json');

    expect(config.ok).toBe(false);
    // The duplicate label is the actual fault, and the message says so.
    expect(config.detail).toContain('same');
  });

  it('fails on JSON that does not parse, pointing at the file', async () => {
    await writeFile(paths.configFile, '{ not json');

    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'config.json').ok).toBe(false);
  });

  it('stops the harness checks it can no longer trust', async () => {
    // The harness blocks live in the config; there is nothing to check under
    // a config that would not parse, and inventing a verdict would be a lie.
    await writeFile(paths.configFile, '{ not json');

    const report = await runDoctor(paths, OFFLINE);

    expect(report.filter((entry) => entry.name.startsWith('harness'))).toEqual(
      [],
    );
  });
});

describe('the endpoint check', () => {
  it('is skipped, not failed, when no publicUrl is set yet', async () => {
    // A developer who has not run `rocky setup` has not got one wrong.
    const report = await runDoctor(paths, OFFLINE);
    const endpoint = check(report, 'publicUrl');

    expect(endpoint.ok).toBe(true);
    expect(endpoint.skipped).toBe(true);
    expect(endpoint.detail).toContain('rocky setup');
  });

  it('pings through the configured publicUrl', async () => {
    await writeInstanceConfig(paths, {
      publicUrl: 'https://rocky.example.com',
    });
    const asked: string[] = [];

    await runDoctor(paths, {
      ...OFFLINE,
      fetch: (url) => {
        asked.push(String(url));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    // Through the public URL, not the loopback one — the whole point is that
    // it is what Linear will reach.
    expect(asked[0]).toContain('https://rocky.example.com');
  });

  it('passes when the ping comes back', async () => {
    await writeInstanceConfig(paths, {
      publicUrl: 'https://rocky.example.com',
    });

    const report = await runDoctor(paths, {
      ...OFFLINE,
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    });

    expect(check(report, 'publicUrl').ok).toBe(true);
  });

  it('fails with the fix when nothing answers', async () => {
    await writeInstanceConfig(paths, {
      publicUrl: 'https://rocky.example.com',
    });

    const report = await runDoctor(paths, OFFLINE);
    const endpoint = check(report, 'publicUrl');

    expect(endpoint.ok).toBe(false);
    expect(endpoint.fix).toBeTruthy();
  });

  it('fails on an answer that is not the daemon', async () => {
    // A tunnel pointing at somebody else's server answers 200 all day.
    await writeInstanceConfig(paths, {
      publicUrl: 'https://rocky.example.com',
    });

    const report = await runDoctor(paths, {
      ...OFFLINE,
      fetch: () => Promise.resolve(new Response('nope', { status: 502 })),
    });

    expect(check(report, 'publicUrl').ok).toBe(false);
    expect(check(report, 'publicUrl').detail).toContain('502');
  });
});

describe('the harness checks', () => {
  it('checks every harness the config configures', async () => {
    await writeInstanceConfig(paths, {
      harnesses: { 'claude-code': { command: '/opt/claude' } },
    });

    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'harness claude-code').ok).toBe(true);
  });

  it('hands the harness its configured block, not a blank one', async () => {
    await writeInstanceConfig(paths, {
      harnesses: { 'claude-code': { command: '/opt/claude/claude' } },
    });
    const seen: unknown[] = [];

    await runDoctor(paths, {
      ...OFFLINE,
      checkHarness: (harness, config) => {
        seen.push(config);
        return Promise.resolve({ harness, ok: true, detail: 'signed in' });
      },
    });

    expect(seen[0]).toMatchObject({ command: '/opt/claude/claude' });
  });

  it('fails the run when a configured harness is not signed in', async () => {
    await writeInstanceConfig(paths, { harnesses: { 'claude-code': {} } });

    const report = await runDoctor(paths, {
      ...OFFLINE,
      checkHarness: (harness) =>
        Promise.resolve({
          harness,
          ok: false,
          detail: 'not signed in',
          fix: 'claude login',
        }),
    });

    expect(check(report, 'harness claude-code').ok).toBe(false);
    expect(check(report, 'harness claude-code').fix).toBe('claude login');
    expect(anyFailed(report)).toBe(true);
  });

  it('still reports an unconfigured harness, but does not fail on it', async () => {
    // Which Harness a Run uses is content (NG-579), so doctor cannot know
    // which of the shipped two matter here. It reports both and fails only on
    // the ones this machine has deliberately configured.
    const report = await runDoctor(paths, {
      ...OFFLINE,
      checkHarness: (harness) =>
        Promise.resolve({
          harness,
          ok: false,
          detail: 'not signed in',
          fix: `${harness} login`,
        }),
    });

    expect(check(report, 'harness claude-code').ok).toBe(false);
    expect(check(report, 'harness claude-code').advisory).toBe(true);
    expect(anyFailed(report)).toBe(false);
  });

  it('covers both shipped harnesses on an unconfigured machine', async () => {
    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'harness claude-code')).toBeTruthy();
    expect(check(report, 'harness opencode')).toBeTruthy();
  });
});

describe('a check that goes wrong rather than failing', () => {
  it('is reported as a failed check, not as a doctor that died', async () => {
    // A doctor that throws on the first problem cannot tell you about the
    // second, which is the entire reason to run it.
    await writeInstanceConfig(paths, { harnesses: { 'claude-code': {} } });

    const report = await runDoctor(paths, {
      ...OFFLINE,
      checkHarness: () => Promise.reject(new Error('the probe exploded')),
    });

    expect(check(report, 'harness claude-code').ok).toBe(false);
    expect(check(report, 'harness claude-code').detail).toContain(
      'the probe exploded',
    );
    // And the checks after it still ran.
    expect(check(report, 'harness opencode')).toBeTruthy();
  });
});

describe('the verdict over the whole run', () => {
  it('is a pass when every check passed', async () => {
    const report = await runDoctor(paths, OFFLINE);

    expect(anyFailed(report)).toBe(false);
  });

  it('is a failure when any non-advisory check failed', async () => {
    await writeFile(paths.configFile, '{ not json');

    expect(anyFailed(await runDoctor(paths, OFFLINE))).toBe(true);
  });

  it('is not tripped by a skipped check', async () => {
    const report = await runDoctor(paths, OFFLINE);

    expect(check(report, 'publicUrl').skipped).toBe(true);
    expect(anyFailed(report)).toBe(false);
  });
});
