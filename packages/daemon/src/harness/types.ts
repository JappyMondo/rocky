import type { McpServer } from '../mcp/config.js';

export type Capability = 'read' | 'edit' | 'bash';

/** The MCP lane expands and authenticates this immediately before an attempt. */
export type ResolvedMcpServer = McpServer;

export interface HarnessInvocation {
  cwd: string;
  prompt: string;
  sessionStorage: 'rocky' | 'opencode';
  model?: string;
  effort?: string;
  capabilities: readonly Capability[];
  mcpServers: readonly ResolvedMcpServer[];
  command: string;
  env: NodeJS.ProcessEnv;
  transcriptPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Emitted while the child is running, after the raw record is persisted. */
  onConfiguration?: (configuration: {
    model?: string;
    variant?: string;
  }) => void;
  onEvent?: (event: HarnessEvent, sessionId: string) => void;
}

export type HarnessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; name: string }
  | { kind: 'tool-result'; name: string }
  | { kind: 'turn-boundary' };

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  usd?: number;
}

export interface HarnessResult {
  text: string;
  model?: string;
  variant?: string;
  events: HarnessEvent[];
  sessionId: string;
  usage?: HarnessUsage;
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
