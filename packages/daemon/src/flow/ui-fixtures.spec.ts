import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  prepareUiFixtures,
  uiFixturesSchema,
  verifyUiFixtureCredentialFile,
  type UiFixtures,
} from './ui-fixtures.js';
const checks = [
  {
    id: 'readonly',
    url: '/items',
    action: 'Open a read-only item',
    expected: 'Controls are hidden',
  },
];
const ready: UiFixtures = {
  status: 'ready',
  fixtures: [
    {
      id: 'readonly',
      url: '/items/fixture',
      instructions: 'Use the documented read-only account.',
      repository: 'sample',
      source: 'tests/fixtures.ts',
      executed: true,
      screenshot: '/run/screenshots/fixture.png',
    },
  ],
  summary: 'Prepared real local fixture',
};
it('prepares missing fixtures, executes configured setup, and verifies before inspection can proceed', async () => {
  const trace: string[] = [];
  const prepare = vi
    .fn()
    .mockImplementationOnce(async () => {
      trace.push('missing');
      return {
        status: 'setup',
        commands: ['sample/seed'],
        summary: 'Seed required',
      };
    })
    .mockImplementationOnce(async () => {
      trace.push('recheck');
      return ready;
    });
  const result = await prepareUiFixtures({
    prepare,
    setup: async () => {
      trace.push('setup');
    },
    verify: async () => {
      trace.push('verify');
    },
  });
  expect(result).toEqual(ready);
  expect(trace).toEqual(['missing', 'setup', 'recheck', 'verify']);
});
it('repairs failed readiness and never turns a blocked prerequisite into success', async () => {
  const prepare = vi.fn(async () => ready);
  const verify = vi
    .fn()
    .mockRejectedValueOnce(new Error('fixture absent'))
    .mockResolvedValue(undefined);
  expect(
    (await prepareUiFixtures({ prepare, verify, setup: vi.fn() })).status,
  ).toBe('ready');
  expect(prepare.mock.calls).toHaveLength(2);
});
it('bounds persistent local blockers independently of product review and stops immediately for missing access', async () => {
  for (const reason of ['environment', 'permission'] as const) {
    const prepare = vi.fn(async (): Promise<UiFixtures> => ({
      status: 'blocked',
      reason,
      summary: 'Unavailable fixture',
    }));
    const verify = vi.fn();
    expect(
      (await prepareUiFixtures({ prepare, verify, setup: vi.fn() })).status,
    ).toBe('blocked');
    expect(prepare).toHaveBeenCalledTimes(reason === 'environment' ? 3 : 1);
    expect(verify).not.toHaveBeenCalled();
  }
});
it('cannot omit checks, reuse absolute endpoints, or request unconfigured setup', () => {
  const schema = uiFixturesSchema(checks, ['sample/seed']);
  expect(schema.safeParse(ready).success).toBe(true);
  expect(schema.safeParse({ ...ready, fixtures: [] }).success).toBe(false);
  expect(
    schema.safeParse({
      ...ready,
      fixtures: [{ ...ready.fixtures[0], url: 'http://example.com/' }],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      status: 'setup',
      commands: ['sample/unknown'],
      summary: 'bad',
    }).success,
  ).toBe(false);
});
it('passes only private Run fixture credentials to the independent inspector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocky-ui-fixture-'));
  try {
    const evidence = join(root, '.rocky-evidence');
    const outside = join(root, 'outside.json');
    const inside = join(evidence, 'accounts.json');
    const escape = join(evidence, 'escape.json');
    await mkdir(evidence, { mode: 0o700 });
    await writeFile(inside, '{}', { mode: 0o600 });
    await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, escape);
    await expect(
      verifyUiFixtureCredentialFile(evidence, inside),
    ).resolves.toBeUndefined();
    await expect(
      verifyUiFixtureCredentialFile(evidence, escape),
    ).rejects.toThrow(/private file inside/);
    await expect(
      verifyUiFixtureCredentialFile(evidence, outside),
    ).rejects.toThrow(/private file inside/);
    const publicFile = join(evidence, 'public.json');
    await writeFile(publicFile, '{}', { mode: 0o644 });
    await expect(
      verifyUiFixtureCredentialFile(evidence, publicFile),
    ).rejects.toThrow(/private file inside/);
    expect(
      uiFixturesSchema(checks, []).safeParse({
        ...ready,
        fixtures: [{ ...ready.fixtures[0], credentialFile: inside }],
      }).success,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
