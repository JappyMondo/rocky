export type Capability = 'read' | 'edit' | 'bash';

export interface ResolvedMcpServer {
  name: string;
  config: Record<string, unknown>;
  authorization?: string;
}

export interface HarnessInvocation {
  cwd: string;
  prompt: string;
  sessionStorage: 'rocky' | 'opencode';
  model?: string;
  capabilities: readonly Capability[];
  mcpServers: readonly ResolvedMcpServer[];
  command: string;
  env: NodeJS.ProcessEnv;
  transcriptPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Emitted while the child is running, after the raw record is persisted. */
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
