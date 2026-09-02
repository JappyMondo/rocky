/**
 * The `~/.rocky` layout (NG-578's filesystem-layout section). NG-594 owns the
 * paths; the tickets named in `paths.ts` fill the contents.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROCKY_HOME_ENV, defaultRockyHome, rockyPaths } from './paths.js';

describe('the root', () => {
  it('is ~/.rocky', () => {
    expect(defaultRockyHome({})).toBe(join(homedir(), '.rocky'));
  });

  it('is overridable, which is what lets a test run against a temp dir', () => {
    expect(defaultRockyHome({ [ROCKY_HOME_ENV]: '/tmp/rocky-test' })).toBe(
      '/tmp/rocky-test',
    );
  });
});

describe('the instance-level paths', () => {
  const paths = rockyPaths('/home/dev/.rocky');

  it('place the two config files, the pidfile and the log where NG-578 says', () => {
    expect(paths.configFile).toBe('/home/dev/.rocky/config.json');
    expect(paths.credentialsFile).toBe('/home/dev/.rocky/credentials.json');
    expect(paths.pidFile).toBe('/home/dev/.rocky/daemon.pid');
    expect(paths.logsDir).toBe('/home/dev/.rocky/logs');
    expect(paths.daemonLog).toBe('/home/dev/.rocky/logs/daemon.log');
  });

  it('give a repo its own clone directory and nothing else inside', () => {
    expect(paths.reposDir).toBe('/home/dev/.rocky/repos');
    expect(paths.repo('niotix')).toBe('/home/dev/.rocky/repos/niotix');
  });
});

describe("a Run's paths", () => {
  const run = rockyPaths('/home/dev/.rocky').run('NG-601-1');

  it('hold the journal, the header, the snapshot, sessions and screenshots', () => {
    expect(run.dir).toBe('/home/dev/.rocky/runs/NG-601-1');
    expect(run.journal).toBe('/home/dev/.rocky/runs/NG-601-1/journal.jsonl');
    expect(run.runJson).toBe('/home/dev/.rocky/runs/NG-601-1/run.json');
    expect(run.snapshotDir).toBe('/home/dev/.rocky/runs/NG-601-1/snapshot');
    expect(run.sessionsDir).toBe('/home/dev/.rocky/runs/NG-601-1/sessions');
    expect(run.screenshotsDir).toBe(
      '/home/dev/.rocky/runs/NG-601-1/screenshots',
    );
  });

  it('put every worktree under one workspace, so a plain Run and a grouped Run are the same shape', () => {
    expect(run.workspaceDir).toBe('/home/dev/.rocky/runs/NG-601-1/workspace');
    expect(run.workspaceRepo('niotix')).toBe(
      '/home/dev/.rocky/runs/NG-601-1/workspace/niotix',
    );
    expect(run.workspaceRepo('niota-api')).toBe(
      '/home/dev/.rocky/runs/NG-601-1/workspace/niota-api',
    );
  });
});

describe('a name that would escape ~/.rocky', () => {
  const paths = rockyPaths('/home/dev/.rocky');

  // config.json is hand-editable, so a repo name reaches these functions from
  // a file a human wrote. A traversing name must not resolve to a real path
  // outside the root, whatever else it does.
  it.each([
    ['..', '..'],
    ['a separator', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a leading traversal', '../../etc'],
    ['an absolute path', '/etc'],
    ['nothing at all', ''],
  ])('is refused: %s', (_label, name) => {
    expect(() => paths.repo(name)).toThrow(/not a valid repo name/i);
    expect(() => paths.run(name)).toThrow(/not a valid run id/i);
    expect(() => paths.run('NG-601-1').workspaceRepo(name)).toThrow(
      /not a valid repo name/i,
    );
  });
});
