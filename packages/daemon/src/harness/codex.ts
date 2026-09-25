import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSessionOwner, runProcess } from './process.js';
import { startCodexReadTools } from './codex-read.js';
import {
  checkMcpDiagnostic,
  checkMcpToolError,
  checkToolAccessError,
} from './mcp-policy.js';
import {
  HarnessError,
  type HarnessEvent,
  type HarnessInvocation,
  type HarnessResult,
  type HarnessUsage,
  type ResolvedMcpServer,
} from './types.js';

export const codex = {
  run: (input: HarnessInvocation) => executeCodex(input),
  resume: (input: HarnessInvocation & { sessionId: string }) =>
    executeCodex(input),
};

async function executeCodex(
  input: HarnessInvocation & { sessionId?: string },
): Promise<HarnessResult> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000);
  input = {
    ...input,
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  };
  input.signal?.throwIfAborted();
  if (input.sessionStorage !== 'codex')
    throw new HarnessError(
      'Codex requires native session storage; set harnesses.codex.sessionStorage to codex.',
      false,
    );
  if (input.sessionId) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.sessionId,
      )
    )
      throw new HarnessError('Invalid Codex session ID', false);
    await assertSessionOwner(
      { ...input, sessionId: input.sessionId },
      'thread_id',
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), 'rocky-codex-'));
  let reader: Awaited<ReturnType<typeof startCodexReadTools>> | undefined;
  try {
    if (input.mcpServers.some(({ name }) => name === 'rocky_read'))
      throw new HarnessError(
        'MCP name rocky_read is reserved by the Codex adapter',
        false,
      );
    if (input.capabilities.includes('read'))
      reader = await startCodexReadTools(input.cwd);
    const servers = [...input.mcpServers, ...(reader ? [reader.server] : [])];
    const env = { ...input.env };
    const mcp: Record<string, unknown> = Object.create(null);
    for (const [index, { name, config }] of servers.entries()) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || Object.hasOwn(mcp, name))
        throw new HarnessError(`Invalid or duplicate MCP name: ${name}`, false);
      if (config.type === 'sse')
        throw new HarnessError(
          `Codex requires streamable HTTP for MCP server ${name}; configure type http or stdio.`,
          false,
        );
      if (config.type === 'stdio') {
        // Native TOML overrides are process arguments. Keep resolved credentials
        // and server arguments in private files, never in Codex's argv.
        const path = join(temporary, `mcp-${index}.json`);
        await writeFile(path, JSON.stringify(config), { mode: 0o600 });
        const proxy = join(temporary, `mcp-${index}.mjs`);
        await writeFile(
          proxy,
          `import {spawn} from 'node:child_process';\nimport {readFileSync} from 'node:fs';\nconst config=JSON.parse(readFileSync(${JSON.stringify(path)},'utf8'));\nconst child=spawn(config.command,config.args??[],{env:{...process.env,...config.env},stdio:'inherit'});\nchild.on('error',()=>process.exit(1));\nfor(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{child.kill(signal);setTimeout(()=>child.kill('SIGKILL'),1000).unref();});\nchild.on('exit',(code)=>process.exit(code??1));\n`,
          { mode: 0o600 },
        );
        mcp[name] = {
          command: process.execPath,
          args: [proxy],
          env_vars: Object.keys(env).filter((key) => env[key] !== undefined),
          required: true,
          default_tools_approval_mode: 'approve',
        };
      } else {
        const headers: Record<string, string> = Object.create(null);
        for (const [headerIndex, [key, value]] of Object.entries(
          config.headers ?? {},
        ).entries()) {
          const variable = `ROCKY_CODEX_MCP_${index}_${headerIndex}`;
          env[variable] = value;
          headers[key] = variable;
        }
        mcp[name] = {
          url: config.url,
          env_http_headers: headers,
          required: true,
          default_tools_approval_mode: 'approve',
        };
      }
    }
    const edit = input.capabilities.includes('edit');
    const gitMetadata =
      edit && input.capabilities.includes('bash')
        ? (input.gitMetadataDirectories ?? []).map((directory) => [
            resolve(directory),
            'write',
          ])
        : [];
    const config: Record<string, unknown> = {
      approval_policy: 'never',
      default_permissions: 'rocky',
      permissions: {
        rocky: {
          extends: edit ? ':workspace' : ':read-only',
          filesystem: Object.fromEntries([
            ...gitMetadata,
            ...(input.writableDirectories ?? []).map((directory) => [
              resolve(directory),
              'write',
            ]),
            ...(input.capabilities.includes('read') && !edit
              ? (input.evidenceDirectories ?? []).map((directory) => [
                  resolve(directory),
                  'write',
                ])
              : []),
          ]),
          network: { enabled: input.capabilities.includes('bash') },
        },
      },
      // Do not load repository policy, hooks, plugins, skills or extra MCPs.
      projects: { [resolve(input.cwd)]: { trust_level: 'untrusted' } },
      mcp_servers: mcp,
      web_search: 'disabled',
      features: {
        shell_tool: input.capabilities.includes('bash'),
        shell_snapshot: false,
        hooks: false,
        plugins: false,
        apps: false,
        multi_agent: false,
        multi_agent_v2: false,
        image_generation: false,
        view_image: false,
        code_mode: false,
        memories: false,
        goals: false,
        tool_suggest: false,
        skill_search: false,
        skill_mcp_dependency_install: false,
        skip_host_skill_discovery: true,
      },
      skills: { bundled: { enabled: false }, include_instructions: false },
      tools: { experimental_request_user_input: { enabled: false } },
      suppress_unstable_features_warning: true,
    };
    if (input.effort) config.model_reasoning_effort = input.effort;
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
    ];
    for (const [key, value] of Object.entries(config))
      args.push('-c', `${key}=${toml(value)}`);
    if (input.model) args.push('--model', input.model);
    if (input.sessionId) args.push('resume', input.sessionId);
    args.push('--', input.prompt);
    const parser = createCodexStream(input.onEvent, servers, input.sessionId);
    const child = await runProcess({
      ...input,
      env,
      args,
      onLine: parser.push,
      onStderrLine: (line) => checkMcpDiagnostic(line, servers),
    });
    try {
      return parser.result();
    } catch (error) {
      if (child.code !== 0)
        throw codexFailure(child.stderr || `exited ${child.code}`);
      throw error;
    }
  } catch (error) {
    if (error instanceof HarnessError)
      throw new HarnessError(
        `codex (${input.model ?? 'default model'}): ${error.message}`,
        error.retryable,
        error.fix,
      );
    throw error;
  } finally {
    try {
      await reader?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

// TOML inline tables, not JSON objects: quoted keys also prevent dotted-key injection.
function toml(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  throw new Error('Unsupported Codex config value');
}

function codexFailure(detail: string): HarnessError {
  const auth =
    /unauthorized|authentication|not (?:logged|signed) in|invalid.*(?:key|token)|401\b|token.*expired/i.test(
      detail,
    );
  const permanent =
    auth ||
    /model.*(?:not found|does not exist|unknown|unsupported|not supported|not available)|(?:unknown|unsupported|invalid).*model|unexpected argument|invalid value|error loading config|permission denied/i.test(
      detail,
    );
  return new HarnessError(
    `Codex: ${detail}`,
    !permanent,
    auth ? 'codex login (or configure CODEX_API_KEY)' : undefined,
  );
}

export function parseCodexStream(
  lines: readonly string[],
  servers: readonly ResolvedMcpServer[] = [],
): HarnessResult {
  const parser = createCodexStream(undefined, servers);
  for (const line of lines) if (line.trim()) parser.push(line);
  return parser.result();
}

function createCodexStream(
  onEvent?: HarnessInvocation['onEvent'],
  servers: readonly ResolvedMcpServer[] = [],
  expectedSession?: string,
) {
  const events: HarnessEvent[] = [];
  const tools = new Map<string, string>();
  const completed = new Set<string>();
  let sessionId: string | undefined;
  let text: string | undefined;
  let finished = false;
  let usage: HarnessUsage | undefined;
  const emit = (event: HarnessEvent) => {
    events.push(event);
    onEvent?.(event, sessionId ?? '');
  };
  return {
    push(line: string) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        throw new HarnessError('Invalid Codex JSON stream');
      }
      if (!record || typeof record.type !== 'string')
        throw new HarnessError('Invalid Codex stream record');
      if (record.type === 'thread.started') {
        if (typeof record.thread_id !== 'string' || !record.thread_id)
          throw new HarnessError('Codex stream is missing thread ID');
        if (
          (sessionId && sessionId !== record.thread_id) ||
          (expectedSession && expectedSession !== record.thread_id)
        )
          throw new HarnessError('Codex stream changed session ID', false);
        sessionId = record.thread_id;
      } else if (record.type === 'turn.started') {
        finished = false;
        text = undefined;
      } else if (record.type === 'turn.completed') {
        if (tools.size)
          throw new HarnessError('Codex completed with unfinished tools');
        const native = record.usage;
        if (native !== undefined) {
          if (!native || typeof native !== 'object' || Array.isArray(native))
            throw new HarnessError('Invalid Codex usage');
          const fields = native as Record<string, unknown>;
          for (const [key, nativeKey] of Object.entries({
            inputTokens: 'input_tokens',
            outputTokens: 'output_tokens',
            cacheReadTokens: 'cached_input_tokens',
            cacheCreationTokens: 'cache_write_input_tokens',
          })) {
            const value = fields[nativeKey];
            if (value === undefined) continue;
            if (
              typeof value !== 'number' ||
              !Number.isFinite(value) ||
              value < 0
            )
              throw new HarnessError('Invalid Codex usage');
            usage ??= {};
            const field = key as keyof HarnessUsage;
            usage[field] = (usage[field] ?? 0) + value;
          }
        }
        finished = true;
        emit({ kind: 'turn-boundary' });
      } else if (record.type === 'turn.failed') {
        throw codexFailure(JSON.stringify(record.error ?? 'turn failed'));
      } else if (record.type === 'error') {
        // Transient connection errors can precede a successful retry. The terminal
        // turn.failed event or process status decides whether the attempt failed.
        if (typeof record.message !== 'string')
          throw new HarnessError('Invalid Codex error record');
        const error = codexFailure(record.message);
        if (!error.retryable) throw error;
      } else if (
        ['item.started', 'item.updated', 'item.completed'].includes(record.type)
      ) {
        const item = record.item as Record<string, unknown> | undefined;
        if (
          !item ||
          typeof item.id !== 'string' ||
          typeof item.type !== 'string'
        )
          throw new HarnessError('Invalid Codex item');
        const done = record.type === 'item.completed';
        if (done && completed.has(item.id)) return;
        const name =
          item.type === 'command_execution'
            ? 'bash'
            : item.type === 'file_change'
              ? 'apply_patch'
              : item.type === 'mcp_tool_call' &&
                  typeof item.server === 'string' &&
                  typeof item.tool === 'string'
                ? `mcp__${item.server}__${item.tool}`
                : item.type === 'web_search'
                  ? 'web_search'
                  : undefined;
        if (name) {
          if (!tools.has(item.id)) {
            tools.set(item.id, name);
            emit({ kind: 'tool-call', name });
          }
          if (done) {
            if (
              item.status === 'failed' ||
              item.error ||
              (typeof item.exit_code === 'number' && item.exit_code !== 0)
            ) {
              checkMcpToolError(
                name,
                item.error ?? item.aggregated_output,
                servers,
                '__',
              );
              checkToolAccessError(name, item.error ?? item.aggregated_output);
            }
            tools.delete(item.id);
            emit({ kind: 'tool-result', name });
            if (!tools.size) emit({ kind: 'turn-boundary' });
          }
        } else if (item.type === 'agent_message') {
          if (done) {
            if (typeof item.text !== 'string')
              throw new HarnessError('Invalid Codex agent message');
            text = item.text;
            emit({ kind: 'text', text });
          }
        } else if (!['reasoning', 'todo_list', 'error'].includes(item.type))
          throw new HarnessError(`Unknown Codex item type: ${item.type}`);
        if (done) completed.add(item.id);
      } else throw new HarnessError(`Unknown Codex event: ${record.type}`);
    },
    result(): HarnessResult {
      if (!sessionId || !finished || text === undefined)
        throw new HarnessError('Codex stream has no final result/session ID');
      return { sessionId, text, events, ...(usage ? { usage } : {}) };
    },
  };
}
