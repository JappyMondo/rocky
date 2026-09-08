import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import type {
  Capability,
  HarnessEvent,
  HarnessResult,
  HarnessUsage,
  HarnessInvocation,
  ResolvedMcpServer,
} from './types.js';
import { HarnessError } from './types.js';
import { assertSessionOwner, runProcess } from './process.js';
import { checkMcpDiagnostic, checkMcpToolError } from './mcp-policy.js';

export const opencode = {
  run: (input: HarnessInvocation) => executeOpencode(input),
  resume: (input: HarnessInvocation & { sessionId: string }) =>
    executeOpencode(input),
};

async function executeOpencode(
  input: HarnessInvocation & { sessionId?: string },
): Promise<HarnessResult> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000);
  input = {
    ...input,
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  };
  input.signal?.throwIfAborted();
  if (input.sessionId)
    await assertSessionOwner(
      { ...input, sessionId: input.sessionId },
      'sessionID',
    );
  const scoped = await createScopedOpencodeConfig(input);
  try {
    const args = ['run', '--format', 'json', '--agent', 'rocky'];
    if (input.mcpServers.length)
      args.push('--print-logs', '--log-level', 'INFO');
    if (input.sessionId) args.push('--session', input.sessionId);
    if (input.model) args.push('--model', input.model);
    args.push('--', input.prompt);
    const env = { ...scoped.env };
    if (input.sessionStorage !== 'opencode') {
      await mkdir(dirname(input.transcriptPath), {
        recursive: true,
        mode: 0o700,
      });
      env.OPENCODE_DB = join(dirname(input.transcriptPath), 'opencode.db');
    }
    const expected = JSON.parse(await readFile(env.OPENCODE_CONFIG, 'utf8'));
    const resolved = await runProcess({
      command: input.command,
      args: ['debug', 'config'],
      cwd: input.cwd,
      env,
      signal: input.signal,
      timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
    });
    let effective: JsonObject;
    try {
      effective = JSON.parse(resolved.stdout);
    } catch {
      throw new HarnessError(
        'opencode could not verify effective configuration; use a supported OpenCode CLI',
        false,
      );
    }
    const active = (effective.agent as Record<string, JsonObject>)?.rocky;
    const conflicts = [
      resolved.code !== 0 && 'CLI config probe',
      !isDeepStrictEqual(effective.permission, expected.permission) &&
        'permissions',
      !isDeepStrictEqual(effective.mcp, expected.mcp) && 'MCP',
      (!Array.isArray(effective.plugin) || effective.plugin.length !== 0) &&
        'plugins',
      (!isDeepStrictEqual(active?.permission, expected.permission) ||
        active?.mode !== 'primary' ||
        active?.tools ||
        active?.disable) &&
        'Agent policy',
      effective.tools && 'legacy tools',
    ].filter(Boolean);
    if (conflicts.length) {
      throw new HarnessError(
        `opencode configuration conflicts with the Step policy (${conflicts.join(', ')}); remove conflicting managed/remote tools, agents, permissions or MCP configuration`,
        false,
      );
    }
    const activeProbe = await runProcess({
      command: input.command,
      args: ['debug', 'agent', 'rocky'],
      cwd: input.cwd,
      env,
      signal: input.signal,
      timeoutMs: 30_000,
    });
    let rules: { permission: string; pattern: string; action: string }[];
    try {
      rules = JSON.parse(activeProbe.stdout).permission;
    } catch {
      throw new HarnessError(
        'opencode could not verify the active Agent policy; use a supported CLI',
        false,
      );
    }
    const boundary = Array.isArray(rules)
      ? rules.findLastIndex(
          (rule) => rule.permission === '*' && rule.pattern === '*',
        )
      : -1;
    if (
      activeProbe.code !== 0 ||
      boundary < 0 ||
      rules[boundary].action !== 'deny' ||
      rules
        .slice(boundary + 1)
        .some(
          (rule) =>
            rule.action !== 'deny' &&
            rule.permission !== 'external_directory' &&
            expected.permission[rule.permission] !== 'allow',
        )
    ) {
      throw new HarnessError(
        'opencode active Agent widens the Step policy; remove conflicting managed Agent permissions',
        false,
      );
    }
    const parser = createOpencodeStream(input.onEvent, input.mcpServers);
    const output = await runProcess({
      ...input,
      args,
      env,
      onLine: parser.push,
      onStderrLine(line) {
        checkMcpDiagnostic(line, input.mcpServers);
      },
    });
    let result: HarnessResult;
    try {
      result = parser.result();
      if (!result.text && output.stderr) throw new Error('No final text');
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (!output.stderr) throw error;
      checkMcpDiagnostic(output.stderr, input.mcpServers);
      const auth = isOpenCodeAuthFailure({ message: output.stderr });
      throw new HarnessError(
        auth
          ? `opencode (${input.model ?? 'default model'}): OpenCode authentication failed`
          : `opencode (${input.model ?? 'default model'}): ${output.stderr.trim()}`,
        !auth &&
          !/(?:unknown|unsupported|invalid) model|model.*(?:not found|unknown|unsupported)|ProviderModelNotFoundError/i.test(
            output.stderr,
          ),
        auth ? 'opencode auth login' : undefined,
      );
    }
    if (input.sessionId && result.sessionId !== input.sessionId)
      throw new HarnessError('opencode resumed a different session', false);
    return result;
  } catch (error) {
    if (
      error instanceof HarnessError &&
      !error.message.startsWith('opencode (')
    )
      throw new HarnessError(
        `opencode (${input.model ?? 'default model'}): ${error.message}`,
        error.retryable,
        error.fix,
      );
    throw error;
  } finally {
    await scoped.dispose();
  }
}

type JsonObject = Record<string, unknown>;

function isOpenCodeAuthFailure(error: JsonObject): boolean {
  const data =
    error.data && typeof error.data === 'object' && !Array.isArray(error.data)
      ? (error.data as JsonObject)
      : {};
  const status = data.statusCode ?? data.status ?? data.code ?? error.status;
  if (status === 401 || status === 403 || status === '401' || status === '403')
    return true;
  const detail = [error.name, error.message, data.name, data.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /\b40[13]\b|oauth_org_not_allowed|auth(?:entication)?(?:[_ -]?error| failed)?|unauthorized|not[- ]?logged(?:[- ]?in)?|invalid (?:API key|token)/i.test(
    detail,
  );
}

type OpencodePermission = 'allow' | 'deny';

export interface ScopedOpencodeConfig {
  cwd: string;
  env: NodeJS.ProcessEnv & { OPENCODE_CONFIG: string; XDG_CONFIG_HOME: string };
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
    servers.map(({ name, config }) => {
      if (config.type === 'stdio') {
        return [
          name,
          {
            type: 'local',
            command: [config.command, ...(config.args ?? [])],
            ...(config.env ? { environment: config.env } : {}),
            enabled: true,
          },
        ] as const;
      }

      return [
        name,
        {
          type: 'remote',
          url: config.url,
          enabled: true,
          oauth: false,
          ...(config.headers ? { headers: { ...config.headers } } : {}),
        },
      ] as const;
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
  const config = { ...globalConfig };
  const directories: string[] = [];
  for (let directory = input.cwd; ; directory = dirname(directory)) {
    directories.unshift(directory);
    if (
      await stat(join(directory, '.git')).then(
        () => true,
        () => false,
      )
    )
      break;
    if (dirname(directory) === directory) break;
  }
  for (const directory of directories) {
    for (const base of [directory, join(directory, '.opencode')]) {
      for (const file of ['opencode.json', 'opencode.jsonc']) {
        mergeConfig(config, await readConfig(join(base, file)));
      }
    }
  }
  const permission = renderOpencodePermissions(input.capabilities);
  for (const server of input.mcpServers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name))
      throw new HarnessError(
        `Invalid MCP name: ${server.name}; use letters, numbers, underscores or hyphens`,
        false,
      );
    permission[`${server.name}_*`] = 'allow';
  }

  const temporaryRoot = await createTemporaryRoot();
  const configHome = join(temporaryRoot, 'xdg');
  const customConfigPath = join(temporaryRoot, 'opencode.json');

  try {
    await mkdir(join(configHome, 'opencode'), { recursive: true });
    await writeFile(
      join(configHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        ...globalConfig,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      customConfigPath,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        ...config,
        permission,
        agent: { rocky: { mode: 'primary', permission } },
        default_agent: 'rocky',
        share: 'disabled',
        autoupdate: false,
        snapshot: false,
        mcp: renderOpencodeMcpServers(input.mcpServers),
      }),
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  const scopedEnv = { ...env };
  delete scopedEnv.OPENCODE_CONFIG_CONTENT;
  delete scopedEnv.OPENCODE_CONFIG_DIR;
  delete scopedEnv.OPENCODE_PLUGIN_META_FILE;

  return {
    cwd: input.cwd,
    env: {
      ...scopedEnv,
      XDG_CONFIG_HOME: configHome,
      OPENCODE_CONFIG: customConfigPath,
      OPENCODE_TEST_HOME: temporaryRoot,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_PURE: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_PERMISSION: JSON.stringify(permission),
    },
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function readGlobalOpencodeConfig(
  env: NodeJS.ProcessEnv,
): Promise<JsonObject> {
  const configHome =
    env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config');
  const configDirectory = join(configHome, 'opencode');

  const config: JsonObject = {};
  for (const filename of ['config.json', 'opencode.json', 'opencode.jsonc'])
    mergeConfig(config, await readConfig(join(configDirectory, filename)));
  if (env.OPENCODE_CONFIG)
    mergeConfig(config, await readConfig(env.OPENCODE_CONFIG));
  if (env.OPENCODE_CONFIG_DIR) {
    for (const file of ['opencode.json', 'opencode.jsonc'])
      mergeConfig(
        config,
        await readConfig(join(env.OPENCODE_CONFIG_DIR, file)),
      );
  }
  if (env.OPENCODE_CONFIG_CONTENT)
    mergeConfig(
      config,
      safeConfig(
        parseGlobalConfig(
          env.OPENCODE_CONFIG_CONTENT,
          'OPENCODE_CONFIG_CONTENT',
        ),
      ),
    );
  return config;
}

async function readConfig(path: string): Promise<JsonObject> {
  try {
    // Preserve native file substitutions relative to their original declaration.
    const source = (await readFile(path, 'utf8')).replace(
      /\{file:([^}]+)\}/g,
      (_, file: string) =>
        `{file:${file.startsWith('/') || file.startsWith('~') ? file : join(dirname(path), file)}}`,
    );
    return safeConfig(parseGlobalConfig(source, path));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

function safeConfig(config: JsonObject): JsonObject {
  // Tool sources, hooks and agent permissions are executable policy, not model configuration.
  return Object.fromEntries(
    Object.entries(config).filter(([key]) =>
      [
        'provider',
        'model',
        'small_model',
        'enabled_providers',
        'disabled_providers',
        'instructions',
        'compaction',
      ].includes(key),
    ),
  );
}

function mergeConfig(target: JsonObject, source: JsonObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prior = target[key];
      const next: JsonObject =
        prior && typeof prior === 'object' && !Array.isArray(prior)
          ? { ...prior }
          : {};
      mergeConfig(next, value as JsonObject);
      target[key] = next;
    } else target[key] = value;
  }
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

export function parseOpencodeStream(
  lines: readonly string[],
  servers: readonly ResolvedMcpServer[] = [],
): HarnessResult {
  const parser = createOpencodeStream(undefined, servers);
  const end = lines.findLastIndex((line) => line.trim() !== '');
  for (const line of lines.slice(0, end + 1)) parser.push(line);
  return parser.result();
}

function createOpencodeStream(
  onEvent?: HarnessInvocation['onEvent'],
  servers: readonly ResolvedMcpServer[] = [],
) {
  const events: HarnessEvent[] = [];
  const text: string[] = [];
  const usage: HarnessUsage = {};
  let hasUsage = false;
  let sessionId: string | undefined;

  const emit = (...next: HarnessEvent[]) => {
    events.push(...next);
    for (const event of next) onEvent?.(event, sessionId ?? '');
  };
  return {
    push(line: string) {
      const event = parseEvent(line);
      const eventSessionId = event.sessionID;
      if (typeof eventSessionId === 'string') {
        if (sessionId && sessionId !== eventSessionId)
          throw new HarnessError('OpenCode stream changed session ID', false);
        sessionId ??= eventSessionId;
      }

      switch (event.type) {
        case 'step_start':
        case 'reasoning':
          break;
        case 'error': {
          const error = objectAt(event, 'error', 'error');
          const data = (
            error.data && typeof error.data === 'object' ? error.data : {}
          ) as JsonObject;
          const message =
            typeof data.message === 'string'
              ? data.message
              : typeof error.message === 'string'
                ? error.message
                : String(error.name ?? 'unknown error');
          checkMcpDiagnostic(JSON.stringify(error), servers);
          const auth = isOpenCodeAuthFailure(error);
          throw new HarnessError(
            `opencode: ${message}`,
            !auth &&
              data.isRetryable !== false &&
              !/(?:unknown|unsupported|invalid) model|model.*(?:not found|unknown|unsupported)|ProviderModelNotFoundError/i.test(
                `${error.name} ${message}`,
              ),
            auth ? 'opencode auth login' : undefined,
          );
        }
        case 'tool_use': {
          const part = objectAt(event, 'part', 'tool_use');
          if (
            part.type !== 'tool' ||
            typeof part.tool !== 'string' ||
            !['completed', 'error'].includes(
              String(objectAt(part, 'state', 'tool_use').status),
            )
          ) {
            throw new Error('Invalid OpenCode tool_use event');
          }
          const state = objectAt(part, 'state', 'tool_use');
          if (state.status === 'error')
            checkMcpToolError(part.tool, state.error, servers, '_');
          emit(
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
            emit({ kind: 'turn-boundary' });
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
          emit({ kind: 'text', text: part.text });
          break;
        }
        default:
          throw new Error(
            `Unknown OpenCode stream event: ${String(event.type)}`,
          );
      }
    },
    result(): HarnessResult {
      if (sessionId === undefined) {
        throw new Error('OpenCode stream did not include a session ID');
      }

      return {
        sessionId,
        text: text.join(''),
        events,
        ...(hasUsage ? { usage } : {}),
      };
    },
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
