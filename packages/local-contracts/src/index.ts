/** JSON wire types only. No Workflow or replay behavior belongs here. */
export type Answer =
  | { decision: 'approve' }
  | { decision: 'reject'; reason?: string }
  | { decision: 'steer'; message: string };

export interface Checkpoint {
  /** Full hierarchical Journal identity, not a label or root sequence alone. */
  stepKey: string;
  generation: string;
  title: string;
  body: string;
  answer?: Answer;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  usd?: number;
}

export interface UsageTotal {
  reported: Usage;
  /** Number of Agent Steps that did not report each component. */
  missing: Record<keyof Usage, number>;
}

export interface RunSummary {
  runId: string;
  issue: { identifier: string; title: string; url: string };
  repo: string;
  branch: string;
  trigger?: string;
  status: 'queued' | 'running' | 'parked' | 'finished' | 'failed' | 'cancelled';
  outcome?: 'merged' | 'rejected' | 'exhausted' | 'completed';
  reason?: string;
  boots: number;
  createdAt: string;
  endedAt?: string;
  artifactsPruned?: boolean;
  pr?: { number: number; url: string; headSha: string };
}

export interface RunList {
  runs: RunSummary[];
  pollAfterMs: 2000 | 30000;
}

export interface StepView {
  key: string;
  parentKey?: string;
  seq: number;
  step: string;
  label?: string;
  stage?: string;
  status: 'running' | 'done' | 'waiting' | 'failed';
  boot: number;
  startedAt: string;
  ms?: number;
  /** Recorded prior completion, not a claim about unrecorded replay visits. */
  completedBeforeCurrentBoot: boolean;
  result?: unknown;
  /** A bounded, durable preview emitted while an Agent Step is still running. */
  liveOutput?: string;
  /** The most recent Agent/tool activity, suitable for a compact status line. */
  liveSummary?: string;
  error?: { name: string; message: string };
  attempts: Array<{
    kind: 'failed' | 'steer';
    startedAt: string;
    ms: number;
    note?: string;
    error?: { name: string; message: string };
  }>;
  transcript: 'available' | 'pending' | 'pruned' | 'unavailable';
  usage?: Usage;
  screenshots: Screenshot[];
}

export interface SteerReceipt {
  requestId: string;
  message: string;
  receivedAt: string;
  state: 'held' | 'delivered';
  /** Per-conversation delivery state survives a partial parallel delivery. */
  targets?: Array<{ stepKey: string; delivered: boolean }>;
}

export interface RunDetail {
  run: RunSummary;
  /** Hash of recorded Step state; raw Transcript growth does not change it. */
  revision: string;
  steps: StepView[];
  checkpoint?: Checkpoint;
  steers: SteerReceipt[];
  usage: UsageTotal;
  diffs: Array<{ id: string; label: string; baseSha: string; headSha: string }>;
  controls: { answer: boolean; steer: boolean };
}

export interface Screenshot {
  id: string;
  caption: string;
}

export interface DiffAnnotation {
  id: string;
  /** Fully namespaced content ID plus producing Step and immutable revision. */
  stepKey: string;
  revision: string;
  file: string;
  line?: number;
  side?: 'base' | 'head';
  text: string;
  state: 'open' | 'fixed' | 'disagreed' | 'withdrawn';
  resolution?: { stepKey: string; label: string; reason?: string };
  screenshots?: Screenshot[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  kind: 'file' | 'directory' | 'missing';
  status:
    'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'unavailable';
  hunks: Array<{
    header: string;
    lines: Array<{
      kind: 'context' | 'add' | 'delete';
      text: string;
      baseLine?: number;
      headLine?: number;
    }>;
  }>;
}

export interface DiffView {
  id: string;
  baseSha: string;
  headSha: string;
  availability: 'available' | 'pruned';
  files: DiffFile[];
  annotations: DiffAnnotation[];
}

export interface SettingsValues {
  server: { host: string; port: number };
  retention: { keepTerminalRuns: number; keepSessionsAndScreenshots: number };
  concurrency: { maxRuns: number };
}

export interface McpStatus {
  name: string;
  status: 'authenticated' | 'login-required' | 'not-required' | 'expired';
  loginCommand: string;
}

export interface SettingsView {
  values: SettingsValues;
  revision: string;
  restartRequired: boolean;
  mcp: McpStatus[];
  mcpAvailable: boolean;
}

/** Secret-free representation of a machine-local repository profile. */
export interface RepositoryProfileView {
  id: string;
  remote: string;
  workflow: { source: string; triggers: string[] };
  grants: {
    harness: 'claude-code' | 'opencode';
    capabilities: Array<'read' | 'edit' | 'bash'>;
    mcp: string[];
  };
  /** File names only; prompt bodies and environment values stay local. */
  prompts: string[];
  rules: string[];
  secretEnv: string[];
  revision: string;
}

export interface RepositoryProfileList {
  profiles: RepositoryProfileView[];
}

/** A safe diagnostic for webhook work that failed after Linear received 200. */
export interface IntakeFailure {
  sessionId: string;
  action: 'created' | 'prompted';
  occurredAt: string;
  reason: string;
  remediation: string;
}

export interface ApiError {
  error: string;
  code: string;
  answer?: Answer;
  runId?: string;
}
