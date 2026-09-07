import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { ConfigError } from '../config/schema.js';

const nameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));
const strings = z.record(z.string(), z.string());
const serverSchema = z.union([
  z.strictObject({
    type: z.literal('stdio').default('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: strings.optional(),
  }),
  z.strictObject({
    type: z.enum(['http', 'sse']).default('http'),
    url: z.string().min(1),
    headers: strings.optional(),
  }),
]);

export const mcpConfigSchema = z.strictObject({
  mcpServers: z
    .unknown()
    .refine(
      (value) =>
        !(
          value !== null &&
          typeof value === 'object' &&
          Object.hasOwn(value, '__proto__')
        ),
    )
    .pipe(z.record(nameSchema, serverSchema)),
});

export type McpServerConfig = z.infer<typeof serverSchema>;
export interface McpConfig {
  file: string;
  mcpServers: Record<string, McpServerConfig>;
}
/** Structurally assignable to HarnessInvocation.mcpServers; no native config. */
export interface McpServer {
  name: string;
  config: McpServerConfig;
}

export function parseMcpConfig(
  raw: unknown,
  file = '.rocky/mcp.json',
): McpConfig {
  const result = mcpConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      file,
      'expected ecosystem mcpServers declarations (stdio command/args/env or http/sse url/headers); remove unsupported fields.',
    );
  }
  return { file, ...result.data };
}

export async function readMcpConfig(file: string): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return parseMcpConfig({ mcpServers: {} }, file);
    throw new ConfigError(
      file,
      'cannot read MCP declarations; check file permissions.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(file, 'not valid JSON; repair the declaration file.');
  }
  return parseMcpConfig(raw, file);
}

export interface McpExpansion {
  env?: NodeJS.ProcessEnv;
  run?: { runDir: string; screenshotDir: string; port: number };
}

export function expandMcpConfig(
  config: McpConfig,
  options: McpExpansion = {},
): McpConfig {
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ...(options.run && {
      ROCKY_RUN_DIR: options.run.runDir,
      ROCKY_SCREENSHOT_DIR: options.run.screenshotDir,
      ROCKY_PORT: String(options.run.port),
    }),
  };
  const expand = (value: string): string =>
    value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback?: string) => {
        const found = Object.hasOwn(env, name) ? env[name] : undefined;
        if (fallback !== undefined && (found === undefined || found === ''))
          return fallback;
        if (found === undefined)
          throw new ConfigError(
            config.file,
            `set environment variable ${name} or supply \${${name}:-default}.`,
          );
        return found;
      },
    );
  const mapStrings = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, expand(value)]),
    );

  const expanded: McpConfig = {
    file: config.file,
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        server.type === 'stdio'
          ? {
              ...server,
              command: expand(server.command),
              ...(server.args && { args: server.args.map(expand) }),
              ...(server.env && { env: mapStrings(server.env) }),
            }
          : {
              ...server,
              url: expand(server.url),
              ...(server.headers && { headers: mapStrings(server.headers) }),
            },
      ]),
    ),
  };
  for (const [name, server] of Object.entries(expanded.mcpServers)) {
    const where = `${config.file} mcpServers.${name}`;
    if (server.type === 'stdio') {
      if (!server.command.trim())
        throw new ConfigError(
          where,
          'command must not be empty after expansion.',
        );
      continue;
    }
    try {
      const url = new URL(server.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ConfigError(
        where,
        'url must be HTTP(S), without embedded credentials or a fragment.',
      );
    }
    const seen = new Set<string>();
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
        /[^\t\x20-\x7e\x80-\xff]/.test(value) ||
        seen.has(header.toLowerCase())
      ) {
        throw new ConfigError(
          where,
          'headers must have valid names and values, without case-insensitive duplicates.',
        );
      }
      seen.add(header.toLowerCase());
    }
  }
  return expanded;
}

export function selectMcpServers(
  config: McpConfig,
  names: readonly string[],
): McpServer[] {
  return [...new Set(names)].map((name) => {
    if (!Object.hasOwn(config.mcpServers, name)) {
      throw new ConfigError(
        config.file,
        `unknown MCP server ${JSON.stringify(name)}; choose from ${Object.keys(config.mcpServers).join(', ') || '(none)'} or declare it in this file.`,
      );
    }
    return { name, config: structuredClone(config.mcpServers[name]) };
  });
}
