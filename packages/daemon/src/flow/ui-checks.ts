import type { Check } from './schemas.js';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isRelativeUiPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

/** Old journals can contain a planner's absolute URL from an earlier Boot.
 * Bind that local route to this Boot's verified service before inspection.
 */
export function bindChecksToEndpoint(
  checks: readonly Check[],
  baseUrl: string,
): Check[] {
  const current = new URL(baseUrl);
  return checks.map((check) => {
    if (isRelativeUiPath(check.url)) return { ...check };
    let planned: URL;
    try {
      planned = new URL(check.url);
    } catch {
      return { ...check };
    }
    if (
      !['http:', 'https:'].includes(planned.protocol) ||
      !loopback.has(planned.hostname) ||
      !loopback.has(current.hostname) ||
      planned.username ||
      planned.password
    )
      return { ...check };
    const route = `${planned.pathname}${planned.search}${planned.hash}`;
    const oldOrigin = planned.origin;
    return {
      ...check,
      url: new URL(route, current).href,
      action: check.action.replaceAll(oldOrigin, current.origin),
      expected: check.expected.replaceAll(oldOrigin, current.origin),
    };
  });
}
