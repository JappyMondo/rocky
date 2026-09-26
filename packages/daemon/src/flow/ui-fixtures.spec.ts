import { expect, it, vi } from 'vitest';
import {
  prepareUiFixtures,
  uiFixturesSchema,
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
