import { expect, it } from 'vitest';
import { bindChecksToEndpoint, isRelativeUiPath } from './ui-checks.js';

it('requires a route path for a new portable UI plan', () => {
  expect(isRelativeUiPath('/settings/users?tab=all')).toBe(true);
  expect(isRelativeUiPath('http://localhost:4201/settings/users')).toBe(false);
  expect(isRelativeUiPath('//external.test/path')).toBe(false);
});

it('rebinds old loopback checks to this Boot without changing external destinations', () => {
  const checks = bindChecksToEndpoint(
    [
      {
        id: 'settings',
        url: 'http://localhost:4201/settings/users?tab=all',
        action: 'Open http://localhost:4201/settings/users',
        expected: 'Return to http://localhost:4201/',
      },
      {
        id: 'relative',
        url: '/dashboard',
        action: 'Open Dashboard',
        expected: 'Dashboard appears',
      },
      {
        id: 'external',
        url: 'https://example.test/login',
        action: 'Open login',
        expected: 'Login appears',
      },
    ],
    'http://127.0.0.1:52065/',
  );
  expect(checks[0]).toEqual({
    id: 'settings',
    url: 'http://127.0.0.1:52065/settings/users?tab=all',
    action: 'Open http://127.0.0.1:52065/settings/users',
    expected: 'Return to http://127.0.0.1:52065/',
  });
  expect(checks[1].url).toBe('/dashboard');
  expect(checks[2].url).toBe('https://example.test/login');
});
