import { HarnessError, type ResolvedMcpServer } from './types.js';

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
    isNativeMcpDiagnostic(detail, name),
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

function isNativeMcpDiagnostic(detail: string, name: string): boolean {
  const value = escapeRegExp(name);
  // A generic `server=…` is not enough: provider/model errors can name a server.
  // Native MCP diagnostics identify the source or use an MCP-specific key.
  const source = /\bmcp(?:[_ -]?server)?\b|server unavailable/i.test(detail);
  const mcpField = new RegExp(
    `(?:mcp|mcpServer|serverName)["']?\\s*[=:]\\s*["']?${value}(?:["'\\s,}]|$)`,
    'i',
  );
  const named = new RegExp(
    `(?:key|name|server)["']?\\s*[=:]\\s*["']?${value}(?:["'\\s,}]|$)|\\b${value}\\b`,
    'i',
  );
  return mcpField.test(detail) || (source && named.test(detail));
}
