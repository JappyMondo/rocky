import { HarnessError, type ResolvedMcpServer } from './types.js';

export function mcpHeaders({
  config,
  authorization,
}: ResolvedMcpServer): Record<string, unknown> {
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  if (authorization === undefined) return { ...headers };
  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(
        ([key]) => key.toLowerCase() !== 'authorization',
      ),
    ),
    Authorization: authorization,
  };
}

export function mcpFailure(name: string, unauthorized = false): HarnessError {
  return new HarnessError(
    unauthorized
      ? `MCP server "${name}" rejected authentication; run rocky mcp login ${name}`
      : `Required MCP server "${name}" is unavailable; check its command/URL in .rocky/mcp.json and run rocky mcp login ${name} if authentication is required`,
    false,
    `rocky mcp login ${name}`,
  );
}

export function checkMcpToolError(
  tool: string,
  error: unknown,
  servers: readonly ResolvedMcpServer[],
  separator: '_' | '__',
): void {
  const detail = typeof error === 'string' ? error : JSON.stringify(error);
  if (
    !/\b40[13]\b|unauthorized|authentication|re-authorization|token expired|expired (?:access )?token|invalid (?:access )?token/i.test(
      detail ?? '',
    )
  )
    return;
  const server = [...servers]
    .sort((a, b) => b.name.length - a.name.length)
    .find(({ name }) =>
      tool.startsWith(separator === '__' ? `mcp__${name}__` : `${name}_`),
    );
  if (server) throw mcpFailure(server.name, true);
}

/** Native startup diagnostics vary by CLI version, but name the configured key. */
export function checkMcpDiagnostic(
  detail: string,
  servers: readonly ResolvedMcpServer[],
): void {
  if (
    !/(?:unavailable|failed|40[13]|unauthorized|authentication|token)/i.test(
      detail,
    )
  )
    return;
  const server = servers.find(({ name }) =>
    new RegExp(
      `(?:key|name|server|mcp)["']?[=:\\s]+["']?${escapeRegExp(name)}(?:["'\\s,}]|$)`,
      'i',
    ).test(detail),
  );
  if (server)
    throw mcpFailure(
      server.name,
      /40[13]|unauthorized|authentication|token/i.test(detail),
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
