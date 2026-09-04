import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import type {
  Capability,
  HarnessEvent,
  HarnessResult,
  HarnessUsage,
  ResolvedMcpServer,
} from './types.js';

type JsonObject = Record<string, unknown>;

type OpencodePermission = 'allow' | 'deny';

export interface ScopedOpencodeConfig {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export function renderOpencodePermissions(
  capabilities: readonly Capability[],
): Record<string, OpencodePermission> {
  const permissions: Record<string, OpencodePermission> = { '*': 'deny' };

  if (capabilities.includes('read')) {
    permissions.read = 'allow';
    permissions.glob = 'allow';
    permissions.grep = 'allow';
  }
  if (capabilities.includes('edit')) permissions.edit = 'allow';
  if (capabilities.includes('bash')) permissions.bash = 'allow';

  return permissions;
}

export function renderOpencodeMcpServers(
  servers: readonly ResolvedMcpServer[],
): Record<string, JsonObject> {
  return Object.fromEntries(
    servers.map(({ name, config, authorization }) => {
      const command = config.command;
      if (
        Array.isArray(command) &&
        command.every((part) => typeof part === 'string')
      ) {
        return [
          name,
          { ...config, type: 'local', command, enabled: true },
        ] as const;
      }

      if (typeof config.url === 'string') {
        return [
          name,
          {
            ...config,
            type: 'remote',
            url: config.url,
            enabled: true,
            ...(authorization === undefined
              ? {}
              : { headers: { Authorization: authorization }, oauth: false }),
          },
        ] as const;
      }

      throw new Error(`Invalid OpenCode MCP server configuration: ${name}`);
    }),
  );
}

export async function createScopedOpencodeConfig(input: {
  cwd: string;
  capabilities: readonly Capability[];
  mcpServers: readonly ResolvedMcpServer[];
  env?: NodeJS.ProcessEnv;
}): Promise<ScopedOpencodeConfig> {
  const env = input.env ?? process.env;
  const globalConfig = await readGlobalOpencodeConfig(env);
  delete globalConfig.mcp;
  delete globalConfig.permission;

  const temporaryRoot = await createTemporaryRoot();
  const configHome = join(temporaryRoot, 'xdg');
  const customConfigPath = join(temporaryRoot, 'opencode.json');

  try {
    await mkdir(join(configHome, 'opencode'), { recursive: true });
    await writeFile(
      join(configHome, 'opencode', 'opencode.json'),
      JSON.stringify(globalConfig),
    );
    await writeFile(
      customConfigPath,
      JSON.stringify({
        permission: renderOpencodePermissions(input.capabilities),
        mcp: renderOpencodeMcpServers(input.mcpServers),
      }),
    );
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const scopedEnv = { ...env };
  delete scopedEnv.OPENCODE_CONFIG_CONTENT;

  return {
    cwd: input.cwd,
    env: {
      ...scopedEnv,
      XDG_CONFIG_HOME: configHome,
      OPENCODE_CONFIG: customConfigPath,
    },
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function readGlobalOpencodeConfig(
  env: NodeJS.ProcessEnv,
): Promise<JsonObject> {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const configDirectory = join(configHome, 'opencode');

  for (const filename of ['opencode.json', 'opencode.jsonc']) {
    const path = join(configDirectory, filename);
    try {
      return parseGlobalConfig(await readFile(path, 'utf8'), path);
    } catch (error: unknown) {
      if (isMissingFile(error)) continue;
      throw error;
    }
  }

  return {};
}

function parseGlobalConfig(source: string, path: string): JsonObject {
  const errors: ParseError[] = [];
  const config = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    errors.length > 0 ||
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config)
  ) {
    throw new Error(`Invalid OpenCode global configuration: ${path}`);
  }
  return config as JsonObject;
}

async function createTemporaryRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'rocky-opencode-'));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function parseOpencodeStream(lines: readonly string[]): HarnessResult {
  const events: HarnessEvent[] = [];
  const text: string[] = [];
  const usage: HarnessUsage = {};
  let hasUsage = false;
  let sessionId: string | undefined;

  let parsedEvent = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (
      parsedEvent &&
      line.trim() === '' &&
      lines.slice(index).every((trailingLine) => trailingLine.trim() === '')
    ) {
      break;
    }
    const event = parseEvent(line);
    parsedEvent = true;
    const eventSessionId = event.sessionID;
    if (typeof eventSessionId === 'string') sessionId ??= eventSessionId;

    switch (event.type) {
      case 'step_start':
        break;
      case 'tool_use': {
        const part = objectAt(event, 'part', 'tool_use');
        if (
          part.type !== 'tool' ||
          typeof part.tool !== 'string' ||
          objectAt(part, 'state', 'tool_use').status !== 'completed'
        ) {
          throw new Error('Invalid OpenCode tool_use event');
        }
        events.push(
          { kind: 'tool-call', name: part.tool },
          { kind: 'tool-result', name: part.tool },
        );
        break;
      }
      case 'step_finish': {
        const part = objectAt(event, 'part', 'step_finish');
        if (part.type !== 'step-finish' || typeof part.reason !== 'string') {
          throw new Error('Invalid OpenCode step_finish event');
        }
        if (part.reason === 'tool-calls') {
          events.push({ kind: 'turn-boundary' });
        }
        addUsage(part, usage, () => {
          hasUsage = true;
        });
        break;
      }
      case 'text': {
        const part = objectAt(event, 'part', 'text');
        if (part.type !== 'text' || typeof part.text !== 'string') {
          throw new Error('Invalid OpenCode text event');
        }
        text.push(part.text);
        events.push({ kind: 'text', text: part.text });
        break;
      }
      default:
        throw new Error(`Unknown OpenCode stream event: ${String(event.type)}`);
    }
  }

  if (sessionId === undefined) {
    throw new Error('OpenCode stream did not include a session ID');
  }

  return {
    sessionId,
    text: text.join(''),
    events,
    ...(hasUsage ? { usage } : {}),
  };
}

function parseEvent(line: string): JsonObject {
  try {
    const event: unknown = JSON.parse(line);
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new Error('not an object');
    }
    const jsonEvent = event as JsonObject;
    if (typeof jsonEvent.type !== 'string') {
      throw new Error('missing type');
    }
    return jsonEvent;
  } catch {
    throw new Error('Invalid OpenCode JSONL event');
  }
}

function objectAt(
  event: JsonObject,
  key: string,
  eventType: string,
): JsonObject {
  const value = event[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid OpenCode ${eventType} event`);
  }
  return value as JsonObject;
}

function addUsage(
  part: JsonObject,
  usage: HarnessUsage,
  foundUsage: () => void,
): void {
  const tokens = part.tokens;
  if (tokens !== undefined) {
    const tokenValues = usageObject(tokens);
    foundUsage();
    addToken(usage, 'inputTokens', tokenValues.input, foundUsage);
    addToken(usage, 'outputTokens', tokenValues.output, foundUsage);
    const cache = tokenValues.cache;
    if (cache !== undefined) {
      const cacheValues = usageObject(cache);
      addToken(usage, 'cacheReadTokens', cacheValues.read, foundUsage);
      addToken(usage, 'cacheCreationTokens', cacheValues.write, foundUsage);
    }
  }
  if (part.cost !== undefined) {
    usage.usd = (usage.usd ?? 0) + usageNumber(part.cost);
    foundUsage();
  }
}

function addToken(
  usage: HarnessUsage,
  key: Exclude<keyof HarnessUsage, 'usd'>,
  value: unknown,
  foundUsage: () => void,
): void {
  if (value === undefined) return;
  usage[key] = (usage[key] ?? 0) + usageNumber(value);
  foundUsage();
}

function usageObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid OpenCode usage');
  }
  return value as JsonObject;
}

function usageNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid OpenCode usage');
  }
  return value;
}
