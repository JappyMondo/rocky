import type {
  Capability,
  HarnessEvent,
  HarnessInvocation,
  HarnessResult,
  HarnessUsage,
} from './types.js';
import { HarnessError } from './types.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertSessionOwner, runProcess } from './process.js';

export const claudeCode = {
  run: (input: HarnessInvocation) => executeClaude(input),
  resume: (input: HarnessInvocation & { sessionId: string }) =>
    executeClaude(input),
  allowedTools(capabilities: readonly Capability[]): string[] {
    return capabilities.flatMap((capability) => {
      if (capability === 'read') return ['Read', 'Glob', 'Grep'];
      if (capability === 'edit') return ['Edit', 'Write'];
      return ['Bash'];
    });
  },
};

async function executeClaude(
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
      'session_id',
    );
  const temporary = await mkdtemp(join(tmpdir(), 'rocky-claude-'));
  try {
    const mcpPath = join(temporary, 'mcp.json');
    const settingsPath = join(temporary, 'settings.json');
    const servers: Record<string, unknown> = {};
    for (const { name, config, authorization } of input.mcpServers) {
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new HarnessError(
          `Invalid MCP name: ${name}; use letters, numbers, underscores or hyphens`,
          false,
        );
      if (typeof config.command === 'string')
        servers[name] = {
          type: 'stdio',
          command: config.command,
          args: config.args ?? [],
          ...(config.env ? { env: config.env } : {}),
        };
      else if (typeof config.url === 'string')
        servers[name] = {
          type: config.type === 'sse' ? 'sse' : 'http',
          url: config.url,
          headers: {
            ...Object.fromEntries(
              Object.entries(
                (config.headers as Record<string, string>) ?? {},
              ).filter(
                ([key]) =>
                  !authorization || key.toLowerCase() !== 'authorization',
              ),
            ),
            ...(authorization ? { Authorization: authorization } : {}),
          },
        };
      else
        throw new HarnessError(
          `Invalid claude-code MCP server: ${name}`,
          false,
        );
    }
    await writeFile(mcpPath, JSON.stringify({ mcpServers: servers }), {
      mode: 0o600,
    });
    await writeFile(
      settingsPath,
      JSON.stringify({
        disableAllHooks: true,
        disableClaudeAiConnectors: true,
        autoMemoryEnabled: false,
      }),
      { mode: 0o600 },
    );
    const native = join(
      dirname(input.transcriptPath),
      `${basename(input.transcriptPath)}.claude`,
    );
    await mkdir(native, { recursive: true, mode: 0o700 });
    const tools = claudeCode.allowedTools(input.capabilities).join(',');
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--setting-sources',
      '',
      '--settings',
      settingsPath,
      '--strict-mcp-config',
      '--mcp-config',
      mcpPath,
      '--tools',
      tools,
      '--allowedTools',
      [
        ...claudeCode.allowedTools(input.capabilities),
        ...input.mcpServers.map(({ name }) => `mcp__${name}__*`),
      ].join(','),
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--no-chrome',
    ];
    if (input.sessionId) args.push('--resume', input.sessionId);
    else args.push('--session-id', randomUUID());
    if (input.model) args.push('--model', input.model);
    args.push('--', input.prompt);
    const parser = createClaudeStream(input.onEvent);
    await runProcess({
      ...input,
      args,
      env: {
        ...input.env,
        CLAUDE_CONFIG_DIR: native,
        CLAUDE_CODE_PROJECT_DIR_NAME: 'step',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: 'false',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      onLine: parser.push,
    });
    const result = parser.result();
    if (input.sessionId && result.sessionId !== input.sessionId)
      throw new HarnessError('claude-code resumed a different session', false);
    return result;
  } catch (error) {
    if (error instanceof HarnessError)
      throw new HarnessError(
        `claude-code (${input.model ?? 'default model'}): ${error.message}`,
        error.retryable,
        error.fix,
      );
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parseClaudeStream(lines: readonly string[]): HarnessResult {
  const parser = createClaudeStream();
  for (const line of lines) if (line.trim()) parser.push(line);
  return parser.result();
}

function createClaudeStream(onEvent?: HarnessInvocation['onEvent']) {
  const events: HarnessEvent[] = [];
  const tools = new Map<string, string>();
  let sessionId: string | undefined;
  let text = '';
  let finished = false;
  let usage: HarnessUsage | undefined;
  const emit = (event: HarnessEvent) => {
    events.push(event);
    onEvent?.(event, sessionId ?? '');
  };
  return {
    push(line: string) {
      const record: Record<string, unknown> = JSON.parse(line);
      if (!record || typeof record.type !== 'string')
        throw new HarnessError('Invalid claude-code stream record');
      if (record.parent_tool_use_id) return;
      if (typeof record.session_id === 'string') {
        if (sessionId && sessionId !== record.session_id)
          throw new HarnessError(
            'claude-code stream changed session ID',
            false,
          );
        sessionId = record.session_id;
      }
      if (record.type === 'assistant' || record.type === 'user') {
        const content = (record.message as { content?: unknown })?.content;
        if (!Array.isArray(content))
          throw new HarnessError('Invalid claude-code message content');
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            typeof block.name === 'string' &&
            typeof block.id === 'string'
          ) {
            tools.set(block.id, block.name);
            emit({ kind: 'tool-call', name: block.name });
          } else if (block.type === 'tool_result') {
            const name = tools.get(block.tool_use_id);
            if (!name)
              throw new HarnessError(
                'claude-code tool result has no matching call',
              );
            emit({ kind: 'tool-result', name });
            emit({ kind: 'turn-boundary' });
          } else if (
            record.type === 'assistant' &&
            block.type === 'text' &&
            typeof block.text === 'string'
          ) {
            emit({ kind: 'text', text: block.text });
          }
        }
      } else if (record.type === 'result') {
        if (record.is_error || record.subtype !== 'success') {
          const error =
            typeof record.result === 'string'
              ? record.result
              : JSON.stringify(record.errors ?? record.subtype);
          const auth =
            /oauth_org_not_allowed|authentication|not logged in|unauthorized|invalid.*(?:key|token)/i.test(
              error,
            );
          throw new HarnessError(
            `claude-code: ${error}`,
            !auth && !/model.*(?:not found|unknown|unsupported)/i.test(error),
            auth
              ? 'claude login (use an account authorized for Claude Code)'
              : undefined,
          );
        }
        if (typeof record.result !== 'string')
          throw new HarnessError('claude-code result is missing final text');
        text = record.result;
        finished = true;
        const tokens = record.usage;
        if (
          tokens !== undefined &&
          (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
        )
          throw new HarnessError('Invalid claude-code usage');
        const native = tokens as Record<string, unknown> | undefined;
        const fields = {
          inputTokens: native?.input_tokens,
          outputTokens: native?.output_tokens,
          cacheReadTokens: native?.cache_read_input_tokens,
          cacheCreationTokens: native?.cache_creation_input_tokens,
          usd: record.total_cost_usd,
        };
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) continue;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw new HarnessError('Invalid claude-code usage');
          usage ??= {};
          usage[key as keyof HarnessUsage] = value;
        }
      } else if (
        ![
          'system',
          'rate_limit_event',
          'tool_progress',
          'tool_use_summary',
          'auth_status',
        ].includes(record.type)
      ) {
        throw new HarnessError(
          `Unknown claude-code stream event: ${record.type}`,
        );
      }
    },
    result(): HarnessResult {
      if (!finished || !sessionId)
        throw new HarnessError(
          'claude-code stream has no final result/session ID',
        );
      return { sessionId, text, events, ...(usage ? { usage } : {}) };
    },
  };
}
