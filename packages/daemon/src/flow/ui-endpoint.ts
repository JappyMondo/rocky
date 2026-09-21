import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { UiEndpoint } from '@rocky/local-contracts';

/** Resolve a launched app's endpoint from data Rocky owns, never agent prose. */
export async function resolveUiEndpoint(
  endpoint: UiEndpoint,
  options: {
    port: number;
    log: string;
    workspace: string;
    execute?: (command: string) => Promise<string>;
  },
): Promise<string | undefined> {
  const address = (value: string | number) => {
    if (/^\d+$/.test(String(value))) {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
      return `http://127.0.0.1:${port}/`;
    }
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  };
  if (endpoint.kind === 'fixed') return address(endpoint.url);
  if (endpoint.kind === 'command') {
    if (!options.execute)
      throw Error('Endpoint command execution is unavailable.');
    return address((await options.execute(endpoint.command)).trim());
  }
  if (endpoint.kind === 'assigned-port') {
    const url = new URL(endpoint.url);
    url.port = String(options.port);
    return url.href;
  }
  if (endpoint.kind === 'output-regex') {
    const match = new RegExp(endpoint.pattern, 'm').exec(options.log);
    const value = match?.groups?.url ?? match?.groups?.port;
    if (!value) return undefined;
    return address(value);
  }
  const file = resolve(options.workspace, endpoint.path);
  if (!file.startsWith(`${resolve(options.workspace)}/`)) return undefined;
  if (
    !(await realpath(file)).startsWith(`${await realpath(options.workspace)}/`)
  )
    return undefined;
  const value = JSON.parse(await readFile(file, 'utf8'));
  const found = endpoint.pointer
    .slice(1)
    .split('/')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[
              key.replaceAll('~1', '/').replaceAll('~0', '~')
            ]
          : undefined,
      value,
    );
  return typeof found === 'number' || typeof found === 'string'
    ? address(found)
    : undefined;
}
