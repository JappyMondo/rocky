import type {
  Capability,
  HarnessEvent,
  HarnessInvocation,
  HarnessResult,
  HarnessUsage,
  ResolvedMcpServer,
} from './types.js';
import { HarnessError } from './types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertSessionOwner, runProcess } from './process.js';
import { checkMcpToolError, mcpFailure } from './mcp-policy.js';
import { prepareClaudeSession } from './claude-session.js';

export function claudeExecutionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

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
  const sessionId = input.sessionId ?? randomUUID();
  let session: Awaited<ReturnType<typeof prepareClaudeSession>> | undefined;
  try {
    session = await prepareClaudeSession(
      input,
      sessionId,
      input.sessionId !== undefined,
    );
    const mcpPath = join(temporary, 'mcp.json');
    const settingsPath = join(temporary, 'settings.json');
    const servers: Record<string, unknown> = {};
    for (const { name, config } of input.mcpServers) {
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new HarnessError(
          `Invalid MCP name: ${name}; use letters, numbers, underscores or hyphens`,
          false,
        );
      if (config.type === 'stdio')
        servers[name] = {
          type: 'stdio',
          command: config.command,
          args: config.args ?? [],
          ...(config.env ? { env: config.env } : {}),
        };
      else
        servers[name] = {
          type: config.type,
          url: config.url,
          ...(config.headers ? { headers: { ...config.headers } } : {}),
        };
    }
    await writeFile(mcpPath, JSON.stringify({ mcpServers: servers }), {
      mode: 0o600,
    });
    await writeFile(
      settingsPath,
      JSON.stringify({
        // User/project settings are disabled; only Rocky's session-routing hook runs.
        hooks: { SessionStart: [{ hooks: [session.hook] }] },
        disableClaudeAiConnectors: true,
        autoMemoryEnabled: false,
      }),
      { mode: 0o600 },
    );
    const tools = claudeCode.allowedTools(input.capabilities).join(',');
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
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
    else args.push('--session-id', sessionId);
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort);
    args.push('--', input.prompt);
    const parser = createClaudeStream(
      input.onEvent,
      input.mcpServers,
      input.onConfiguration,
    );
    await runProcess({
      ...input,
      args,
      env: claudeExecutionEnv(input.env),
      onLine(line) {
        const record = JSON.parse(line);
        if (record.type === 'system' && record.subtype === 'init') {
          try {
            session?.verify();
          } catch {
            throw new HarnessError(
              'Claude session storage is not Run-owned; enable the Rocky SessionStart hook and check the Run/projects directory permissions',
              false,
            );
          }
        }
        parser.push(line);
      },
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
    try {
      await session?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export function parseClaudeStream(
  lines: readonly string[],
  servers: readonly ResolvedMcpServer[] = [],
): HarnessResult {
  const parser = createClaudeStream(undefined, servers);
  for (const line of lines) if (line.trim()) parser.push(line);
  return parser.result();
}

function createClaudeStream(
  onEvent?: HarnessInvocation['onEvent'],
  servers: readonly ResolvedMcpServer[] = [],
  onConfiguration?: HarnessInvocation['onConfiguration'],
) {
  const events: HarnessEvent[] = [];
  const tools = new Map<string, string>();
  let sessionId: string | undefined;
  let model: string | undefined;
  let text = '';
  let finished = false;
  let streaming = false;
  let settledTools = false;
  let usage: HarnessUsage | undefined;
  const emit = (event: HarnessEvent) => {
    events.push(event);
    onEvent?.(event, sessionId ?? '');
  };
  const boundary = () => {
    if (settledTools && !streaming && tools.size === 0) {
      settledTools = false;
      emit({ kind: 'turn-boundary' });
    }
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
      if (record.type === 'stream_event') {
        const event = record.event as { type?: string } | undefined;
        if (event?.type === 'message_start') streaming = true;
        if (event?.type === 'message_stop') {
          streaming = false;
          boundary();
        }
      } else if (record.type === 'system' && record.subtype === 'init') {
        if (typeof record.model === 'string') {
          model = record.model;
          onConfiguration?.({ model });
        }
        const statuses = Array.isArray(record.mcp_servers)
          ? record.mcp_servers
          : [];
        for (const { name } of servers) {
          const server = statuses.find((item) => item.name === name);
          if (server?.status !== 'connected')
            throw mcpFailure(name, server?.status === 'needs-auth');
        }
      } else if (record.type === 'assistant' || record.type === 'user') {
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
            if (block.is_error)
              checkMcpToolError(name, block.content, servers, '__');
            emit({ kind: 'tool-result', name });
            tools.delete(block.tool_use_id);
            settledTools = true;
            boundary();
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
      return {
        sessionId,
        text,
        events,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}
