import { HarnessContinuationError } from '../harness/types.js';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  AgentBlockedError,
  agentToolInstructions,
  checkAgentBlocker,
} from './agent-tools.js';
import { isAbsolute, join, relative } from 'node:path';

import type { AgentCallOpts, WorkflowContext } from '@rocky/sdk';
import { z } from 'zod';

import type { RockyPaths } from '../config/paths.js';
import { recordError } from './journal.js';
import { loadMcpRuntime, type ResolvedMcpServer } from './mcp-contract.js';
import type { BootContext } from './replay.js';

const progressSchema = z.object({
  kind: z.literal('agent'),
  configuration: z
    .object({
      harness: z.string(),
      model: z.string().optional(),
      variant: z.string().optional(),
      tools: z.array(z.string()),
      mcp: z.array(z.string()),
      timeoutMs: z.number(),
    })
    .optional(),
  attempt: z.number().int().min(1).max(3),
  startedAt: z.number(),
  deadline: z.number(),
  phase: z.enum(['cold', 'invoking', 'resume', 'backoff', 'failed']),
  sessionId: z.string().optional(),
  repairError: z.string().optional(),
  nudges: z.array(z.object({ error: z.string() })),
  usage: z.record(z.string(), z.number()),
  turns: z.array(
    z.object({
      id: z.string(),
      ids: z.array(z.string()).min(1).optional(),
      note: z.string(),
    }),
  ),
  delivered: z.array(z.string()),
  retryNotes: z.array(z.string()).optional(),
  live: z
    .object({
      output: z.string(),
      summary: z.string(),
    })
    .optional(),
  continuation: z.enum(['schema', 'steer', 'shutdown', 'blocker']).optional(),
  blockerRecovery: z.boolean().optional(),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),
});

export interface AgentTurn {
  id: string;
  /** Control batches retain their individual durable receipt IDs. */
  ids?: string[];
  note: string;
}

export interface AgentContinuation {
  readonly identity: string;
  readonly label: string;
  /** The nearest enclosing parallel Step, shared by its sibling Agents. */
  readonly group?: string;
  steer(turn: AgentTurn): Promise<void>;
}

/** Linear control registers durable targets before the first Harness invocation. */
export interface AgentSteerRegistry {
  register(
    handle: AgentContinuation,
  ): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
  /** Called only at a Harness turn boundary or after an invocation settles. */
  take?(handle: AgentContinuation): Promise<readonly AgentTurn[]>;
  /** Called after the Agent has durably recorded the matching continuation. */
  delivered?(
    handle: AgentContinuation,
    turns: readonly AgentTurn[],
  ): Promise<void>;
}

export type AgentCapability = 'read' | 'edit' | 'bash';

/** Matches the Harness #20 invocation contract without owning its adapters. */
export interface AgentHarnessInvocation {
  cwd: string;
  prompt: string;
  sessionStorage: 'rocky' | 'opencode' | 'codex';
  model?: string;
  effort?: string;
  capabilities: readonly AgentCapability[];
  gitMetadataDirectories?: readonly string[];
  evidenceDirectories?: readonly string[];
  writableDirectories?: readonly string[];
  mcpServers: readonly ResolvedMcpServer[];
  command: string;
  env: NodeJS.ProcessEnv;
  transcriptPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onConfiguration?: (configuration: {
    model?: string;
    variant?: string;
  }) => void;
  onEvent?: (event: AgentHarnessEvent, sessionId: string) => void;
}

export type AgentHarnessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; name: string }
  | { kind: 'tool-result'; name: string }
  | { kind: 'heartbeat'; summary: string }
  | { kind: 'turn-boundary' };

const LIVE_OUTPUT_LIMIT = 12_000;

/** A compact, transcript-safe description for live status surfaces. */
export function describeAgentEvent(event: AgentHarnessEvent): string {
  switch (event.kind) {
    case 'text':
      return event.text.trim() || 'Agent is responding…';
    case 'tool-call':
      return `Running ${event.name}…`;
    case 'tool-result':
      return `Finished ${event.name}.`;
    case 'heartbeat':
      return event.summary;
    case 'turn-boundary':
      return 'Agent is preparing its next action…';
  }
}

export interface AgentHarnessResult {
  text: string;
  model?: string;
  variant?: string;
  events: AgentHarnessEvent[];
  sessionId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    usd?: number;
  };
}

export interface AgentHarnessAdapter {
  run(input: AgentHarnessInvocation): Promise<AgentHarnessResult>;
  resume(
    input: AgentHarnessInvocation & { sessionId: string },
  ): Promise<AgentHarnessResult>;
}

export interface AgentOptions {
  screenshotDir?: string;
  snapshotDir: string;
  cwd: string;
  sessionDir: string;
  gitMetadataDirectories?: readonly string[];
  harness: string;
  harnesses: Record<
    string,
    {
      command: string;
      env: NodeJS.ProcessEnv;
      sessionStorage: 'rocky' | 'opencode' | 'codex';
    }
  >;
  signal?: AbortSignal;
  /** Only used by direct consumers without production's per-Boot resolver. */
  mcpRun?: { runDir: string; screenshotDir: string; port: number };
  mcpPaths?: RockyPaths;
  onEvent?: (
    identity: string,
    event: AgentHarnessEvent,
    sessionId: string,
  ) => void;
  steer?: AgentSteerRegistry;
  adapterFor?: (name: string) => AgentHarnessAdapter | undefined;
  resolveServers?: (
    names: readonly string[],
    signal: AbortSignal,
  ) => Promise<ResolvedMcpServer[]>;
  prepareEnvironment?: (
    harness: string,
    tools: readonly AgentCapability[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<{
    env: NodeJS.ProcessEnv;
    instructions?: string;
    writableDirectories?: readonly string[];
    dispose(): Promise<void>;
  }>;
  heartbeatIntervalMs?: number;
}

class SteerBoundary extends Error {
  constructor() {
    super('Harness turn reached a Steer boundary');
    this.name = 'SteerBoundary';
  }
}

const harnessModule = ['..', 'harness', 'adapter.js'].join('/');

async function adapterFor(
  name: string,
): Promise<AgentHarnessAdapter | undefined> {
  let loaded: unknown;
  try {
    loaded = await import(harnessModule);
  } catch (error) {
    throw new Error(
      `Harness ${name} is unavailable: ${error instanceof Error ? error.message : String(error)}. Integrate Harness #20 before running this Agent Step.`,
    );
  }
  const resolve =
    loaded && typeof loaded === 'object'
      ? (loaded as { getHarnessAdapter?: unknown }).getHarnessAdapter
      : undefined;
  if (typeof resolve !== 'function') {
    throw new Error(
      'Harness #20 must expose getHarnessAdapter(name) before running this Agent Step.',
    );
  }
  const adapter = resolve(name);
  if (
    !adapter ||
    typeof adapter !== 'object' ||
    !('run' in adapter) ||
    typeof adapter.run !== 'function' ||
    !('resume' in adapter) ||
    typeof adapter.resume !== 'function'
  ) {
    throw new Error(
      `Harness #20 returned no runnable adapter for ${name}; configure claude-code, opencode or codex in the instance config.`,
    );
  }
  return adapter as AgentHarnessAdapter;
}

function blockerRecoveryPrompt(blocker: string | undefined): string {
  return `Diagnose the blocker once using only the existing grants and remaining deadline. Previous blocker: ${blocker ?? 'Unknown blocker'}
First check the supplied validationResponsibility and repositoryCatalog: a matching non-manual command is owned by host Workflow validation. If only that configured check is denied by your sandbox, finish the assigned source work, name the command ID in the normal result and report validation as pending; do not claim success for an unexecuted check or bypass permissions. No such handoff exists for unconfigured or manual commands.
If actual missing authorization, credentials, hardware, a human decision or an unavailable tool prevents your remaining assigned work, return the blocked envelope immediately; do not bypass it or change external systems.
If an available repository command fails or hangs, inspect its logs, scripts, subprocesses and narrower checks to identify and repair the underlying local cause. Stop only processes owned by this task. Do not repeat equivalent stalled commands, weaken checks, fabricate evidence, or treat partial validation as complete. Preserve committed work. Rerun the repository's actual affected validation after a concrete repair. Return the normal result only on verified completion; otherwise return the precise remaining blocked envelope. This is the single diagnostic recovery opportunity, not permission for an unbounded retry.`;
}

function repairPrompt(error: string | undefined): string {
  return `Your result did not satisfy the schema: ${error ?? 'output was not a valid result object'}\nReturn corrected JSON inside <result>...</result>, including summary.`;
}

function validationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4096 ? message : `${message.slice(0, 4093)}...`;
}

function parallelGroup(identity: string): string | undefined {
  const segments = identity.split('/');
  return segments.length < 3 ? undefined : segments.slice(0, -2).join('/');
}

/**
 * The Agent Step owns retry policy and output extraction. Harnesses own their
 * process groups, raw Transcripts, policy rendering and session storage.
 */
export function createAgent(
  steps: BootContext,
  runtime: AgentOptions,
): WorkflowContext['agent'] {
  async function agent(
    source: string | { prompt: string },
    opts: AgentCallOpts = {},
  ): Promise<unknown> {
    const label =
      opts.label ?? (typeof source === 'string' ? source : undefined);
    if (!label) {
      throw new Error(
        typeof source === 'string'
          ? 'Agent Step requires a nonempty label'
          : 'Inline Agent prompt requires a label',
      );
    }
    return steps.step('agent', { label }, async (handle) => {
      let prompt: string;
      if (typeof source === 'string') {
        const file = join(runtime.snapshotDir, 'agents', `${source}.md`);
        const actual = await realpath(file).catch(() =>
          handle.fail(
            new Error(
              `Missing Agent prompt ${file}; add this prose markdown file to .rocky/agents and start a new Run`,
            ),
          ),
        );
        const root = await realpath(runtime.snapshotDir);
        const path = relative(root, actual);
        if (
          path.startsWith('..') ||
          isAbsolute(path) ||
          !/^[\w-]+$/.test(source)
        ) {
          throw new Error(`Agent prompt must be inside the snapshot: ${file}`);
        }
        prompt = await readFile(actual, 'utf8');
        if (/^\s*---(?:\r?\n|$)/.test(prompt)) {
          throw new Error(
            `Remove frontmatter from ${file}; Agent options belong at the Workflow call site`,
          );
        }
      } else {
        prompt = source.prompt;
      }

      prompt = `Run workspace: ${runtime.cwd}\nWork only in this workspace and its repository members. Never substitute the daemon checkout or another repository for the assigned workspace.\n\n${agentToolInstructions(opts)}\n\n${prompt}`;
      const summary = z.object({ summary: z.string() });
      const schema = opts.schema;
      const jsonSchema = z.toJSONSchema(schema ?? summary, {
        unrepresentable: 'any',
      });
      prompt += `\n\nInput:\n${JSON.stringify(opts.input ?? null)}\n\nReturn one JSON object inside <result>...</result>. Include a string summary. Output schema:\n${JSON.stringify({ ...jsonSchema, properties: { ...('properties' in jsonSchema ? jsonSchema.properties : {}), summary: { type: 'string' } }, required: [...('required' in jsonSchema && Array.isArray(jsonSchema.required) ? jsonSchema.required : []), 'summary'] })}`;

      const harness = opts.harness ?? runtime.harness;
      const adapter = runtime.adapterFor
        ? runtime.adapterFor(harness)
        : await adapterFor(harness);
      const config = runtime.harnesses[harness];
      if (!adapter || !config) {
        throw new Error(
          `Unknown Harness ${harness}; configure claude-code, opencode or codex in the instance config`,
        );
      }

      let resolveServers = runtime.resolveServers;
      if (!resolveServers) {
        resolveServers = async (names, signal) => {
          if (names.length === 0) return [];
          if (!runtime.mcpRun || !runtime.mcpPaths) {
            throw new Error(
              'Configure a per-Boot MCP resolver before enabling MCP servers for an Agent Step.',
            );
          }
          const mcp = await loadMcpRuntime();
          const declarations = await mcp.readMcpConfig(
            join(runtime.snapshotDir, 'mcp.json'),
          );
          const expanded = mcp.expandMcpConfig(declarations, {
            env: config.env,
            run: runtime.mcpRun,
          });
          return mcp.resolveMcpServers(expanded, names, {
            paths: runtime.mcpPaths,
            signal,
          });
        };
      }

      const signal = runtime.signal ?? new AbortController().signal;
      // Full repository checks can exceed 90 minutes on resource-limited hosts;
      // keep the shorter default for read-only agents and explicit overrides.
      const timeout =
        opts.timeout ??
        (opts.tools?.includes('edit') && opts.tools.includes('bash')
          ? 180 * 60_000
          : 30 * 60_000);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(
          'Agent timeout must be a positive number of milliseconds',
        );
      }
      const retryProgress = z
        .object({
          kind: z.literal('agent-retry'),
          notes: z.array(z.string()),
          delivered: progressSchema.shape.delivered,
        })
        .safeParse(handle.progress);
      const storedProgress =
        handle.progress === undefined || retryProgress.success
          ? undefined
          : progressSchema.parse(handle.progress);
      const retryNotes = retryProgress.success
        ? retryProgress.data.notes
        : (storedProgress?.retryNotes ?? []);
      if (retryNotes.length)
        prompt += `\n\nPrior human directions for this retried Step:\n${retryNotes.join('\n\n')}`;
      const fresh = (attempt: number): z.infer<typeof progressSchema> => {
        const startedAt = Date.now();
        return {
          kind: 'agent',
          configuration: {
            harness,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { variant: opts.effort } : {}),
            tools: opts.tools ?? [],
            mcp: opts.mcp ?? [],
            timeoutMs: timeout,
          },
          attempt,
          startedAt,
          deadline: startedAt + timeout,
          phase: 'cold',
          retryNotes,
          nudges: [],
          usage: {},
          turns: [],
          delivered: [],
          live: { output: '', summary: 'Starting agent…' },
        };
      };
      let progress = storedProgress ?? {
        ...fresh(1),
        delivered: retryProgress.success ? retryProgress.data.delivered : [],
      };
      if (progress.phase === 'failed') {
        if (!progress.error) {
          throw new Error(
            'Agent Step failed without a durable error; preserve the Journal and re-run the Workflow',
          );
        }
        throw Object.assign(new Error(progress.error.message), progress.error);
      }

      const queued = new Map<
        string,
        {
          turn: AgentTurn;
          resolve(): void;
          reject(error: unknown): void;
          promise: Promise<void>;
        }
      >();
      let accepting = true;
      // Harness callbacks are synchronous, whereas Journal writes are not.
      // Serialize the latter and join them before settling the Step so a live
      // preview can never be lost behind the final result.
      let eventWrites = Promise.resolve();
      let lastActivityAt = Date.now();
      let lastEventSummary = 'Starting agent…';
      const streamEvent = (event: AgentHarnessEvent, sessionId: string) => {
        const summary = describeAgentEvent(event);
        lastActivityAt = Date.now();
        lastEventSummary = summary;
        const previous = progress.live?.output ?? '';
        const output =
          event.kind === 'text'
            ? `${previous}${event.text}`.slice(-LIVE_OUTPUT_LIMIT)
            : previous;
        progress = { ...progress, sessionId, live: { output, summary } };
        eventWrites = eventWrites.then(() => handle.update(progress));
        void eventWrites.catch(() => undefined);
        try {
          runtime.onEvent?.(handle.identity, event, sessionId);
        } catch {
          // Presentation must never strand a durable Step.
        }
      };
      const acceptTurn = (turn: AgentTurn): Promise<void> => {
        if (!accepting) {
          return Promise.reject(
            new Error(
              'Agent conversation is closed; retain the Steer for the next Agent',
            ),
          );
        }
        if (
          progress.delivered.includes(turn.id) ||
          progress.turns.some((known) => known.id === turn.id)
        ) {
          return Promise.resolve();
        }
        const existing = queued.get(turn.id);
        if (existing) return existing.promise;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        void promise.catch(() => undefined);
        queued.set(turn.id, {
          turn: { ...turn },
          resolve,
          reject,
          promise,
        });
        return promise;
      };
      const group = parallelGroup(handle.identity);
      const conversation: AgentContinuation = {
        identity: handle.identity,
        label,
        ...(group === undefined ? {} : { group }),
        steer: acceptTurn,
      };
      const unregister = runtime.steer
        ? await runtime.steer.register(conversation)
        : undefined;

      const pullSteers = async (): Promise<void> => {
        const turns = await runtime.steer?.take?.(conversation);
        if (!turns) return;
        const alreadyDurable: AgentTurn[] = [];
        for (const turn of turns) {
          if (
            progress.delivered.includes(turn.id) ||
            progress.turns.some((known) => known.id === turn.id)
          ) {
            alreadyDurable.push(turn);
          } else {
            void acceptTurn(turn);
          }
        }
        if (alreadyDurable.length > 0) {
          await runtime.steer?.delivered?.(conversation, alreadyDurable);
        }
      };

      const continueWithSteers = async (
        sessionId: string,
      ): Promise<boolean> => {
        const newlyDurable: AgentTurn[] = [];
        for (const [id, pending] of queued) {
          if (!progress.delivered.includes(id)) {
            progress.turns.push(pending.turn);
            newlyDurable.push(pending.turn);
          }
        }
        if (progress.turns.length === 0) return false;
        progress = {
          ...progress,
          sessionId,
          phase: 'resume',
          continuation: 'steer',
        };
        delete progress.repairError;
        const note = progress.turns.map((turn) => turn.note).join('\n\n');
        // Store continuation intent before its display history. A crash between
        // these writes can resume the same session, but cannot acknowledge it.
        await handle.update(progress);
        await handle.record(
          {
            kind: 'steer',
            attempt: progress.attempt,
            startedAt: new Date(progress.startedAt).toISOString(),
            ms: Date.now() - progress.startedAt,
            note,
            sessionId,
            usage: progress.usage,
            nudges: progress.nudges,
          },
          progress,
        );
        if (newlyDurable.length > 0) {
          await runtime.steer?.delivered?.(conversation, newlyDurable);
        }
        for (const turn of progress.turns) {
          queued.get(turn.id)?.resolve();
          queued.delete(turn.id);
        }
        return true;
      };

      let preparedEnvironment:
        | Awaited<ReturnType<NonNullable<AgentOptions['prepareEnvironment']>>>
        | undefined;
      try {
        while (true) {
          if (!preparedEnvironment && runtime.prepareEnvironment) {
            preparedEnvironment = await runtime.prepareEnvironment(
              harness,
              opts.tools ?? [],
              config.env,
              signal,
            );
            if (preparedEnvironment.instructions)
              prompt += `\n\nRuntime environment: ${preparedEnvironment.instructions}`;
          }
          if (progress.phase === 'backoff') {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
              }, 3000);
              const abort = () => {
                clearTimeout(timer);
                reject(signal.reason);
              };
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
            progress = {
              ...fresh(progress.attempt + 1),
              turns: progress.turns,
              delivered: progress.delivered,
            };
          }
          if (progress.phase === 'invoking' && handle.plannedInterruption) {
            progress = {
              ...progress,
              phase: progress.sessionId ? 'resume' : 'cold',
              ...(progress.sessionId
                ? { continuation: 'shutdown' as const }
                : {}),
            };
            await handle.update(progress);
          }
          if (progress.phase === 'invoking') {
            const failure = new Error(
              `Agent attempt ${progress.attempt} did not settle before this Boot; retrying on the retained worktree`,
            );
            const recorded = recordError(failure);
            progress = {
              ...progress,
              phase: progress.attempt === 3 ? 'failed' : 'backoff',
              error: recorded,
            };
            delete progress.sessionId;
            delete progress.continuation;
            delete progress.repairError;
            await handle.record(
              {
                kind: 'failed',
                attempt: progress.attempt,
                startedAt: new Date(progress.startedAt).toISOString(),
                ms: Date.now() - progress.startedAt,
                error: recorded,
                usage: progress.usage,
                nudges: progress.nudges,
              },
              progress,
            );
            if (progress.phase === 'failed') throw failure;
            continue;
          }
          await handle.update(progress);

          const timeoutController = new AbortController();
          const boundaryController = new AbortController();
          const attemptSignal = AbortSignal.any([
            signal,
            timeoutController.signal,
            boundaryController.signal,
          ]);
          const timeoutError = new Error(
            `Agent attempt ${progress.attempt} timed out after ${timeout}ms`,
          );
          const timer = setTimeout(
            () => timeoutController.abort(timeoutError),
            Math.max(0, progress.deadline - Date.now()),
          );
          let boundaryWrite = Promise.resolve();
          let boundaryRequested = false;
          try {
            while (true) {
              signal.throwIfAborted();
              if (Date.now() >= progress.deadline) throw timeoutError;
              if (progress.phase === 'resume') {
                await pullSteers();
                if (queued.size > 0 && progress.sessionId) {
                  if (await continueWithSteers(progress.sessionId)) continue;
                }
              }
              const continuation =
                progress.phase === 'resume'
                  ? {
                      sessionId: progress.sessionId,
                      kind: progress.continuation,
                      prompt:
                        progress.continuation === 'steer'
                          ? progress.turns.map((turn) => turn.note).join('\n\n')
                          : progress.continuation === 'shutdown'
                            ? 'The daemon intentionally stopped for maintenance. Continue this same task in the retained workspace and session. Inspect any interrupted commands and current repository state before repeating work; do not assume unfinished validation passed. The original deadline and tool grants still apply.'
                            : progress.continuation === 'blocker'
                              ? blockerRecoveryPrompt(progress.repairError)
                              : repairPrompt(progress.repairError),
                    }
                  : undefined;
              if (
                continuation &&
                (!continuation.sessionId ||
                  !continuation.kind ||
                  (continuation.kind === 'steer' && !continuation.prompt))
              ) {
                throw new Error(
                  'Agent continuation is missing its durable session or Steer intent; preserve the Journal and repair the control record before retrying.',
                );
              }
              let mcpServers: ResolvedMcpServer[];
              try {
                mcpServers = await resolveServers(
                  opts.mcp ?? [],
                  attemptSignal,
                );
              } catch (error) {
                if (attemptSignal.aborted) throw attemptSignal.reason;
                throw Object.assign(
                  new Error(
                    error instanceof Error
                      ? error.message
                      : 'MCP preparation failed; check snapshot mcp.json and rocky mcp login',
                  ),
                  { retryable: false },
                );
              }
              attemptSignal.throwIfAborted();
              if (opts.screenshotWrite) {
                if (!runtime.screenshotDir)
                  throw new Error('Run screenshot directory is unavailable.');
                await mkdir(runtime.screenshotDir, {
                  recursive: true,
                  mode: 0o700,
                });
              }
              progress = { ...progress, phase: 'invoking' };
              await handle.update(progress);
              attemptSignal.throwIfAborted();
              const invocation: AgentHarnessInvocation = {
                ...config,
                cwd: runtime.cwd,
                prompt: continuation?.prompt ?? prompt,
                env: {
                  ...config.env,
                  ...preparedEnvironment?.env,
                  ROCKY_BROWSER_SESSION: `rocky-${createHash('sha256').update(runtime.sessionDir).update(handle.identity).digest('hex').slice(0, 16)}`,
                  ROCKY_NODE: process.execPath,
                  ROCKY_MERMAID_CHECK: fileURLToPath(
                    new URL('./mermaid-check.js', import.meta.url),
                  ),
                },
                model: opts.model,
                effort: opts.effort,
                capabilities: opts.tools ?? [],
                gitMetadataDirectories: runtime.gitMetadataDirectories,
                writableDirectories: opts.screenshotWrite
                  ? [
                      ...new Set([
                        ...(preparedEnvironment?.writableDirectories ?? []),
                        ...(runtime.screenshotDir
                          ? [runtime.screenshotDir]
                          : []),
                      ]),
                    ]
                  : preparedEnvironment?.writableDirectories,
                ...(runtime.screenshotDir &&
                opts.tools?.includes('read') &&
                !opts.tools.includes('edit')
                  ? { evidenceDirectories: [runtime.screenshotDir] }
                  : {}),
                mcpServers,
                transcriptPath: join(
                  runtime.sessionDir,
                  `${handle.identity.replaceAll('/', '-')}.jsonl`,
                ),
                signal: attemptSignal,
                timeoutMs: Math.max(1, progress.deadline - Date.now()),
                onConfiguration: (configuration) => {
                  progress = {
                    ...progress,
                    configuration: {
                      harness,
                      tools: opts.tools ?? [],
                      mcp: opts.mcp ?? [],
                      timeoutMs: timeout,
                      ...progress.configuration,
                      ...configuration,
                    },
                  };
                  eventWrites = eventWrites.then(() => handle.update(progress));
                  void eventWrites.catch(() => undefined);
                },
                onEvent: (event, sessionId) => {
                  streamEvent(event, sessionId);
                  if (
                    event.kind !== 'turn-boundary' ||
                    boundaryRequested ||
                    !sessionId
                  ) {
                    return;
                  }
                  boundaryRequested = true;
                  progress = { ...progress, sessionId };
                  boundaryWrite = boundaryWrite.then(async () => {
                    await pullSteers();
                    await handle.update(progress);
                    if (!boundaryController.signal.aborted && queued.size > 0) {
                      boundaryController.abort(new SteerBoundary());
                    } else {
                      boundaryRequested = false;
                    }
                  });
                  void boundaryWrite.catch(() => undefined);
                },
              };
              let result: AgentHarnessResult;
              const heartbeat = setInterval(() => {
                if (
                  Date.now() - lastActivityAt <
                  (runtime.heartbeatIntervalMs ?? 30_000)
                )
                  return;
                const elapsed = Math.floor(
                  (Date.now() - progress.startedAt) / 60_000,
                );
                const remaining = Math.max(
                  0,
                  Math.ceil((progress.deadline - Date.now()) / 60_000),
                );
                const quietSeconds = Math.floor(
                  (Date.now() - lastActivityAt) / 1000,
                );
                const quiet =
                  quietSeconds < 60
                    ? `${quietSeconds}s`
                    : `${Math.floor(quietSeconds / 60)}m`;
                const summary = `${lastEventSummary} (no new output for ${quiet}; ${elapsed}m elapsed; ${remaining}m until timeout)`;
                progress = {
                  ...progress,
                  live: { output: progress.live?.output ?? '', summary },
                };
                eventWrites = eventWrites.then(() => handle.update(progress));
                void eventWrites.catch(() => undefined);
                if (progress.sessionId) {
                  try {
                    runtime.onEvent?.(
                      handle.identity,
                      { kind: 'heartbeat', summary },
                      progress.sessionId,
                    );
                  } catch {
                    // Presentation must never strand the Agent Step.
                  }
                }
              }, runtime.heartbeatIntervalMs ?? 30_000);
              try {
                if (continuation) {
                  if (!continuation.sessionId) {
                    throw new Error(
                      'Agent continuation is missing its durable session; preserve the Journal and repair the control record before retrying.',
                    );
                  }
                  result = await adapter.resume({
                    ...invocation,
                    sessionId: continuation.sessionId,
                  });
                } else {
                  result = await adapter.run(invocation);
                }
              } catch (error) {
                await boundaryWrite;
                await eventWrites;
                if (boundaryController.signal.reason instanceof SteerBoundary) {
                  if (!progress.sessionId) throw error;
                  if (await continueWithSteers(progress.sessionId)) break;
                }
                if (
                  error instanceof HarnessContinuationError &&
                  progress.nudges.length < 2
                ) {
                  attemptSignal.throwIfAborted();
                  progress = {
                    ...progress,
                    sessionId: error.sessionId,
                    phase: 'resume',
                    continuation: 'schema',
                    repairError: error.message,
                    nudges: [...progress.nudges, { error: error.message }],
                  };
                  await handle.update(progress);
                  continue;
                }
                throw error;
              } finally {
                clearInterval(heartbeat);
              }
              await boundaryWrite;
              await eventWrites;
              progress = {
                ...progress,
                sessionId: result.sessionId,
                configuration: {
                  harness,
                  tools: opts.tools ?? [],
                  mcp: opts.mcp ?? [],
                  timeoutMs: timeout,
                  ...progress.configuration,
                  ...(result.model ? { model: result.model } : {}),
                  ...(result.variant ? { variant: result.variant } : {}),
                },
              };
              for (const [key, value] of Object.entries(result.usage ?? {})) {
                if (typeof value === 'number') {
                  progress.usage[key] = (progress.usage[key] ?? 0) + value;
                }
              }
              await pullSteers();
              if (boundaryController.signal.reason instanceof SteerBoundary) {
                if (await continueWithSteers(result.sessionId)) break;
              }
              attemptSignal.throwIfAborted();
              if (continuation?.kind === 'steer') {
                progress = {
                  ...progress,
                  delivered: [
                    ...progress.delivered,
                    ...progress.turns.map((turn) => turn.id),
                  ],
                  turns: [],
                };
                delete progress.continuation;
              }
              if (await continueWithSteers(result.sessionId)) continue;
              try {
                checkAgentBlocker(result.text);
              } catch (error) {
                if (
                  !(error instanceof AgentBlockedError) ||
                  !error.blocker ||
                  !opts.tools?.includes('bash') ||
                  !opts.tools.includes('edit') ||
                  progress.blockerRecovery ||
                  progress.nudges.length >= 2
                )
                  throw error;
                attemptSignal.throwIfAborted();
                progress = {
                  ...progress,
                  phase: 'resume',
                  continuation: 'blocker',
                  blockerRecovery: true,
                  repairError: error.message,
                  nudges: [...progress.nudges, { error: error.message }],
                };
                await handle.update(progress);
                continue;
              }
              try {
                const match = /<result>([\s\S]*?)<\/result>/.exec(result.text);
                const encoded = match?.[1];
                if (!encoded) {
                  throw new Error('Expected JSON inside <result>...</result>');
                }
                const value: unknown = JSON.parse(encoded);
                const injected = summary.parse(value);
                let output: unknown = injected;
                if (schema) {
                  // Preserve object-level Zod refinements instead of trusting JSON Schema.
                  const fields = z.record(z.string(), z.unknown()).parse(value);
                  const schemaOwnsSummary =
                    (schema instanceof z.ZodObject &&
                      'summary' in schema.shape) ||
                    (schema instanceof z.ZodUnion &&
                      schema.options.every(
                        (option) =>
                          option instanceof z.ZodObject &&
                          'summary' in option.shape,
                      ));
                  if (!schemaOwnsSummary) {
                    delete fields.summary;
                  }
                  output = {
                    ...z
                      .record(z.string(), z.unknown())
                      .parse(await schema.parseAsync(fields)),
                    ...injected,
                  };
                }
                attemptSignal.throwIfAborted();
                if (await continueWithSteers(result.sessionId)) continue;
                accepting = false;
                await handle.update(progress);
                for (const id of progress.delivered) {
                  queued.get(id)?.resolve();
                  queued.delete(id);
                }
                return {
                  status: 'done',
                  result: output,
                  sessionId: result.sessionId,
                };
              } catch (error) {
                attemptSignal.throwIfAborted();
                if (progress.nudges.length >= 2) throw error;
                const message = validationMessage(error);
                progress = {
                  ...progress,
                  phase: 'resume',
                  continuation: 'schema',
                  repairError: message,
                  nudges: [...progress.nudges, { error: message }],
                };
                await handle.update(progress);
              }
            }
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            let failure = timeoutController.signal.aborted
              ? timeoutError
              : error;
            const permanent =
              typeof failure === 'object' &&
              failure !== null &&
              (('retryable' in failure && failure.retryable === false) ||
                ('fatal' in failure && failure.fatal === true));
            if (
              failure instanceof Error &&
              'fix' in failure &&
              typeof failure.fix === 'string' &&
              !failure.message.includes(failure.fix)
            ) {
              failure = Object.assign(
                new Error(`${failure.message}; run \`${failure.fix}\``),
                { name: failure.name },
              );
            }
            const recorded = recordError(failure);
            progress = {
              ...progress,
              phase: permanent || progress.attempt === 3 ? 'failed' : 'backoff',
              error: recorded,
            };
            await handle.record(
              {
                kind: 'failed',
                attempt: progress.attempt,
                startedAt: new Date(progress.startedAt).toISOString(),
                ms: Date.now() - progress.startedAt,
                error: recorded,
                ...(progress.sessionId
                  ? { sessionId: progress.sessionId }
                  : {}),
                usage: progress.usage,
                nudges: progress.nudges,
              },
              progress,
            );
            if (permanent || progress.attempt === 3) throw failure;
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        await preparedEnvironment?.dispose();
        accepting = false;
        await unregister?.();
        for (const pending of queued.values()) {
          pending.reject(
            new Error(
              'Agent ended before Steer delivery; retain the pending turn',
            ),
          );
        }
      }
    });
  }
  return agent as WorkflowContext['agent'];
}
