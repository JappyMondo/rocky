/**
 * AC3: a delegation matching no repo entry produces a visible refusal — wired
 * into the agent session by NG-598, but the lookup and its miss are here.
 * AC4: a grouped lookup resolves lead and members; a repo in two groups
 * resolves in both.
 */
import { describe, expect, it } from 'vitest';

import { parseCredentials, parseInstanceConfig } from './schema.js';
import {
  groupsForRepo,
  resolveGroup,
  resolveRepoEnv,
  route,
} from './routing.js';

const config = parseInstanceConfig({
  repos: [
    {
      name: 'niotix',
      url: 'a',
      baseBranch: 'main',
      label: 'rocky',
      env: { NIOTIX_ENV: 'ci' },
    },
    { name: 'niota-api', url: 'b', baseBranch: 'main', label: 'rocky-api' },
    {
      name: 'grid',
      url: 'c',
      baseBranch: 'develop',
      label: 'rocky-grid',
      teams: ['Niotix Grid', 'Platform'],
    },
  ],
  groups: [
    {
      name: 'platform',
      label: 'rocky-platform',
      repos: ['niotix', 'niota-api'],
      workflow: 'niotix',
    },
    {
      name: 'everything',
      label: 'rocky-all',
      repos: ['niotix', 'niota-api', 'grid'],
      workflow: 'grid',
    },
  ],
});

describe('a delegation carrying a repo label', () => {
  it('routes to that repo entry', () => {
    const result = route(config, { labels: ['rocky'] });

    expect(result).toMatchObject({ kind: 'repo', repo: { name: 'niotix' } });
  });

  it('ignores the labels that mean nothing to Rocky', () => {
    const result = route(config, { labels: ['bug', 'p1', 'rocky-api'] });

    expect(result).toMatchObject({ kind: 'repo', repo: { name: 'niota-api' } });
  });

  it('matches the label whatever the casing, as state names do', () => {
    expect(route(config, { labels: ['Rocky'] })).toMatchObject({
      kind: 'repo',
      repo: { name: 'niotix' },
    });
  });
});

describe('the optional teams filter', () => {
  it('is ANDed with the label', () => {
    expect(
      route(config, { labels: ['rocky-grid'], team: 'Niotix Grid' }),
    ).toMatchObject({ kind: 'repo', repo: { name: 'grid' } });
  });

  it('refuses a matching label from a team the entry does not list', () => {
    const result = route(config, { labels: ['rocky-grid'], team: 'Growth' });

    expect(result).toMatchObject({ kind: 'refusal', reason: 'team-filtered' });
    // The refusal has to name the fix, not merely decline (CONTEXT.md): which
    // entry, which team it saw, and which teams the entry does allow.
    const message = result.kind === 'refusal' ? result.message : '';
    expect(message).toContain('grid');
    expect(message).toContain('Growth');
    expect(message).toContain('Niotix Grid');
    expect(message).toMatch(/teams/);
  });

  it('does not constrain an entry that lists no teams', () => {
    expect(
      route(config, { labels: ['rocky'], team: 'Any Team At All' }),
    ).toMatchObject({ kind: 'repo', repo: { name: 'niotix' } });
  });
});

describe('a delegation carrying a group label', () => {
  it('resolves the lead and every member, in the group order', () => {
    const result = route(config, { labels: ['rocky-platform'] });

    expect(result).toMatchObject({
      kind: 'group',
      group: { name: 'platform' },
      lead: { name: 'niotix' },
    });
    expect(
      result.kind === 'group' && result.members.map((m) => m.name),
    ).toEqual(['niotix', 'niota-api']);
  });

  it('names a lead that is not simply the first member', () => {
    const result = route(config, { labels: ['rocky-all'] });

    expect(result).toMatchObject({ kind: 'group', lead: { name: 'grid' } });
  });
});

describe('a repo that belongs to two groups', () => {
  it('resolves in both, and stays routable alone by its own label', () => {
    expect(groupsForRepo(config, 'niotix').map((g) => g.name)).toEqual([
      'platform',
      'everything',
    ]);

    expect(route(config, { labels: ['rocky'] })).toMatchObject({
      kind: 'repo',
      repo: { name: 'niotix' },
    });
    expect(route(config, { labels: ['rocky-platform'] })).toMatchObject({
      kind: 'group',
      group: { name: 'platform' },
    });
    expect(route(config, { labels: ['rocky-all'] })).toMatchObject({
      kind: 'group',
      group: { name: 'everything' },
    });
  });
});

describe('a delegation matching nothing', () => {
  it('refuses, listing what Rocky is actually routed by', () => {
    const result = route(config, { labels: ['some-other-team'] });

    expect(result.kind).toBe('refusal');
    expect(result.kind === 'refusal' && result.message).toMatch(
      /rocky[\s\S]*rocky-api[\s\S]*rocky-platform/,
    );
  });

  it('refuses an issue with no labels at all', () => {
    expect(route(config, { labels: [] }).kind).toBe('refusal');
  });

  it('refuses on an empty config without pretending there is a default repo', () => {
    const empty = parseInstanceConfig({});

    const result = route(empty, { labels: ['rocky'] });

    expect(result.kind).toBe('refusal');
    expect(result.kind === 'refusal' && result.message).toMatch(
      /no repo entries/i,
    );
  });
});

describe('a delegation matching two destinations', () => {
  it('refuses rather than picking one, and names both', () => {
    // Two Rocky labels on one issue has no right answer, and guessing would
    // silently work on the wrong repo.
    const result = route(config, { labels: ['rocky', 'rocky-api'] });

    expect(result.kind).toBe('refusal');
    expect(result.kind === 'refusal' && result.message).toMatch(
      /niotix[\s\S]*niota-api/,
    );
  });

  it('refuses a repo label and a group label together', () => {
    expect(route(config, { labels: ['rocky', 'rocky-all'] }).kind).toBe(
      'refusal',
    );
  });
});

describe('resolving a group by name', () => {
  it('hands back the lead and the members', () => {
    const resolved = resolveGroup(config, 'platform');

    expect(resolved.lead.name).toBe('niotix');
    expect(resolved.members.map((m) => m.name)).toEqual([
      'niotix',
      'niota-api',
    ]);
  });

  it('throws on a name no group has', () => {
    expect(() => resolveGroup(config, 'ghost')).toThrow(/ghost/);
  });
});

describe("a repo's Run env", () => {
  const credentials = parseCredentials({
    repos: { niotix: { NPM_TOKEN: 'npm_xxx' } },
  });

  it("is the config entry plus that repo's credentials section", () => {
    expect(resolveRepoEnv(config, credentials, 'niotix')).toEqual({
      NIOTIX_ENV: 'ci',
      NPM_TOKEN: 'npm_xxx',
    });
  });

  it('lets the secret win, so a placeholder in config cannot mask it', () => {
    const shadowed = parseInstanceConfig({
      repos: [
        {
          name: 'niotix',
          url: 'a',
          baseBranch: 'main',
          label: 'rocky',
          env: { NPM_TOKEN: 'set-in-credentials' },
        },
      ],
    });

    expect(resolveRepoEnv(shadowed, credentials, 'niotix')).toEqual({
      NPM_TOKEN: 'npm_xxx',
    });
  });

  it('is empty for a repo with neither', () => {
    expect(resolveRepoEnv(config, credentials, 'niota-api')).toEqual({});
  });
});
