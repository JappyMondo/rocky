/** Repository evidence is a reference, never executable authority or a credential. */
export interface EnvironmentSource {
  path: string;
  section?: string;
}
export interface EnvironmentCapability {
  id: string;
  kind:
    'runtime' | 'dependencies' | 'browser' | 'login' | 'fixture' | 'feature';
  baseline: boolean;
  sources: EnvironmentSource[];
  /** Catalog IDs, including the repository ID. Setup must be explicitly authorized. */
  setup: string[];
  services: string[];
  verify: string;
  /** Every named assertion must be executed and pass in the verifier's JSON output. */
  checks: string[];
  authentication?: {
    kind: 'documented-local' | 'secret-env';
    reference: string;
  };
  fixture?: 'simulated' | 'real-integration';
}
export interface EnvironmentRecipe {
  version: 1;
  capabilities: EnvironmentCapability[];
}
export interface EnvironmentBlocker {
  kind: 'environment' | 'product' | 'human';
  code:
    | 'unsupported'
    | 'configuration'
    | 'authorization'
    | 'credentials'
    | 'permission'
    | 'external'
    | 'service'
    | 'verification'
    | 'budget';
  capability: string;
  action: string;
}
export interface VerifiedEnvironment {
  version: 1;
  endpoints: Record<string, Record<string, string>>;
  capabilities: Array<{
    id: string;
    repository: string;
    kind: EnvironmentCapability['kind'];
    sources: EnvironmentSource[];
    checks: string[];
    authentication?: EnvironmentCapability['authentication'];
    fixture?: EnvironmentCapability['fixture'];
  }>;
  limitations: string[];
}
export type EnvironmentResult =
  | { status: 'ready'; context: VerifiedEnvironment }
  | { status: 'blocked'; blocker: EnvironmentBlocker };
export interface EnvironmentJob {
  id: string;
  status:
    | 'discovering'
    | 'provisioning'
    | 'verifying'
    | 'repairing'
    | 'ready'
    | 'blocked';
  startedAt: string;
  /** Ready proves this disposable workspace only; Runs verify again. */
  result?: EnvironmentResult;
  evidence: Array<{ label: string; result: unknown }>;
}
