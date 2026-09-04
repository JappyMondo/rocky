export type Capability = 'read' | 'edit' | 'bash';

export interface ResolvedMcpServer {
  name: string;
  config: Record<string, unknown>;
  authorization?: string;
}

export interface HarnessInvocation {
  cwd: string;
  prompt: string;
  model?: string;
  capabilities: readonly Capability[];
  mcpServers: readonly ResolvedMcpServer[];
  command: string;
  env: NodeJS.ProcessEnv;
  transcriptPath: string;
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

export interface HarnessAuthResult {
  authenticated: boolean;
  fix?: string;
}

export interface HarnessAdapter {
  run(invocation: HarnessInvocation): Promise<HarnessResult>;
  resume(
    invocation: HarnessInvocation & { sessionId: string },
  ): Promise<HarnessResult>;
  checkAuth(input: {
    command: string;
    env: NodeJS.ProcessEnv;
  }): Promise<HarnessAuthResult>;
}
