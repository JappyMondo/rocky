/**
 * The typed shape of `config.json` and `credentials.json` (NG-578's config
 * section, NG-579's `harnesses` block).
 *
 * The theme here is that a hand-edited file fails at the boundary with a
 * message naming the fix, rather than resolving into something plausible that
 * misroutes a delegation an hour later.
 */
import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  SHIPPED_HARNESSES,
  parseCredentials,
  parseInstanceConfig,
} from './schema.js';

/** The smallest config that routes anything. */
const oneRepo = {
  repos: [
    {
      name: 'niotix',
      url: 'git@github.com:digimondo/niotix.git',
      baseBranch: 'main',
      label: 'rocky',
    },
  ],
};

describe('an empty config', () => {
  it('is legal, and carries the settled defaults', () => {
    const config = parseInstanceConfig({});

    expect(config.server).toEqual({ host: '127.0.0.1', port: 7625 });
    expect(config.retention).toEqual({
      keepTerminalRuns: 100,
      keepSessionsAndScreenshots: 40,
    });
    expect(config.repos).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(config.harnesses).toEqual({});
  });
});

describe('a repo entry', () => {
  it('is { name, url, baseBranch, label, teams?, env? }', () => {
    const config = parseInstanceConfig({
      repos: [
        {
          name: 'niotix',
          url: 'git@github.com:digimondo/niotix.git',
          baseBranch: 'main',
          label: 'rocky',
          teams: ['Niotix Grid'],
          env: { NODE_ENV: 'test' },
        },
      ],
    });

    expect(config.repos[0]).toMatchObject({
      name: 'niotix',
      baseBranch: 'main',
      label: 'rocky',
      teams: ['Niotix Grid'],
      env: { NODE_ENV: 'test' },
    });
  });

  it('needs a routing label, since a repo nothing routes to is a typo', () => {
    expect(() =>
      parseInstanceConfig({
        repos: [{ name: 'niotix', url: 'u', baseBranch: 'main' }],
      }),
    ).toThrow(ConfigError);
  });

  it('cannot be named something that would escape ~/.rocky', () => {
    expect(() =>
      parseInstanceConfig({
        repos: [
          { name: '../etc', url: 'u', baseBranch: 'main', label: 'rocky' },
        ],
      }),
    ).toThrow(/name/i);
  });

  it('cannot share a name with another entry', () => {
    expect(() =>
      parseInstanceConfig({
        repos: [
          { name: 'niotix', url: 'a', baseBranch: 'main', label: 'one' },
          { name: 'niotix', url: 'b', baseBranch: 'main', label: 'two' },
        ],
      }),
    ).toThrow(/duplicate repo name.*niotix/i);
  });

  it('cannot share a routing label with anything else, whatever the casing', () => {
    // Two entries answering to one label is a delegation with no right answer.
    // Catching it here keeps the routing lookup total.
    expect(() =>
      parseInstanceConfig({
        repos: [
          { name: 'niotix', url: 'a', baseBranch: 'main', label: 'rocky' },
          { name: 'niota-api', url: 'b', baseBranch: 'main', label: 'Rocky' },
        ],
      }),
    ).toThrow(/label.*rocky/i);
  });
});

describe('a repo group', () => {
  const twoRepos = [
    { name: 'niotix', url: 'a', baseBranch: 'main', label: 'niotix' },
    { name: 'niota-api', url: 'b', baseBranch: 'main', label: 'niota-api' },
  ];

  it('names its members and its lead', () => {
    const config = parseInstanceConfig({
      repos: twoRepos,
      groups: [
        {
          name: 'platform',
          label: 'rocky-platform',
          repos: ['niotix', 'niota-api'],
          workflow: 'niotix',
        },
      ],
    });

    expect(config.groups[0]).toMatchObject({
      name: 'platform',
      label: 'rocky-platform',
      repos: ['niotix', 'niota-api'],
      workflow: 'niotix',
    });
  });

  it('cannot reference a repo entry that does not exist', () => {
    expect(() =>
      parseInstanceConfig({
        repos: twoRepos,
        groups: [
          {
            name: 'platform',
            label: 'p',
            repos: ['niotix', 'ghost'],
            workflow: 'niotix',
          },
        ],
      }),
    ).toThrow(/ghost/);
  });

  it('cannot pick a lead that is not one of its own members', () => {
    expect(() =>
      parseInstanceConfig({
        repos: twoRepos,
        groups: [
          {
            name: 'platform',
            label: 'p',
            repos: ['niotix'],
            workflow: 'niota-api',
          },
        ],
      }),
    ).toThrow(/workflow.*niota-api/i);
  });
});

describe('the harnesses block', () => {
  it('accepts opencode but refuses claude-code', () => {
    const config = parseInstanceConfig({
      ...oneRepo,
      harnesses: {
        opencode: {
          command: '/opt/opencode/opencode',
          env: { OPENCODE_CONFIG_DIR: '${ROCKY_WORK_OPENCODE}' },
        },
      },
    });

    expect(config.harnesses.opencode).toEqual({
      command: '/opt/opencode/opencode',
      env: { OPENCODE_CONFIG_DIR: '${ROCKY_WORK_OPENCODE}' },
    });

    expect(() =>
      parseInstanceConfig({ ...oneRepo, harnesses: { 'claude-code': {} } }),
    ).toThrow(/claude-code.*opencode/s);
  });

  it('refuses a harness Rocky ships no adapter for, and names the ones it does', () => {
    // NG-579 killed "configurable but untested": an untested stream parser is
    // not degraded, it is broken.
    expect(() =>
      parseInstanceConfig({ ...oneRepo, harnesses: { cursor: {} } }),
    ).toThrow(/cursor.*opencode/s);

    expect(SHIPPED_HARNESSES).toEqual(['opencode']);
  });
});

describe('the retention knobs', () => {
  it('cannot keep sessions for more Runs than are kept at all', () => {
    expect(() =>
      parseInstanceConfig({
        retention: { keepTerminalRuns: 10, keepSessionsAndScreenshots: 40 },
      }),
    ).toThrow(/keepSessionsAndScreenshots/);
  });
});

describe('a key Rocky does not know', () => {
  it('survives parsing, so a hand-edit is never silently eaten', () => {
    // config.json is hand-editable and Rocky rewrites it from the web UI. A
    // schema that stripped unknown keys would delete a human's line on the
    // next PATCH.
    const config = parseInstanceConfig({
      ...oneRepo,
      somethingFromANewerRocky: { keep: 'me' },
    });

    expect(config).toMatchObject({ somethingFromANewerRocky: { keep: 'me' } });
  });
});

describe('credentials', () => {
  it('hold the Linear tokens and the per-repo secret sections', () => {
    const credentials = parseCredentials({
      linear: { accessToken: 'lin_oauth_xxx', webhookSecret: 'whsec_xxx' },
      repos: { niotix: { NPM_TOKEN: 'npm_xxx' } },
    });

    expect(credentials.linear?.accessToken).toBe('lin_oauth_xxx');
    expect(credentials.repos.niotix).toEqual({ NPM_TOKEN: 'npm_xxx' });
  });

  it('pass the mcp block through untouched, because NG-583 owns its shape', () => {
    const credentials = parseCredentials({
      mcp: {
        'https://mcp.linear.app/sse': { refreshToken: 'x', expiresAt: 1 },
      },
    });

    expect(credentials.mcp).toEqual({
      'https://mcp.linear.app/sse': { refreshToken: 'x', expiresAt: 1 },
    });
  });

  it('default to empty rather than failing a machine that has none yet', () => {
    expect(parseCredentials({})).toEqual({ repos: {}, mcp: {} });
  });
});
