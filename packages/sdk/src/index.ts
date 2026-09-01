/**
 * `@rocky/sdk` — types and builders, never behaviour (ADR 0003).
 *
 * A repo installs this as an ordinary devDependency so its `.rocky/` typechecks
 * with no Rocky daemon present. Every runtime export here is either a Trigger
 * builder or the re-exported schema library; `src/purity.spec.ts` holds that
 * line as the package grows.
 */

// One schema library for everyone, so a consumer repo declares exactly one
// Rocky-related dependency.
export { z } from 'zod';

export { linear, manual } from './triggers.js';

export type {
  LinearDelegateTrigger,
  ManualTrigger,
  Trigger,
  Triggers,
} from './triggers.js';

export type {
  AgentCallOpts,
  CheckpointAnswer,
  CiResult,
  ExecResult,
  FailedJob,
  Issue,
  LinearOps,
  Pr,
  ReviewThread,
  RunOutcome,
  ScmOps,
  ScmRefusal,
  Workflow,
  WorkflowContext,
} from './ctx.js';
