import type { Versions } from "../store/index.js";
import type {
  Action,
  Event,
  ExecutionQualification,
  HardLimitsCapability,
} from "./contracts.js";
/** Trusted host seam, not an agent tool or provider capability claim.
 * begin initiates synchronously, honors stable key/deadline and never retries internally.
 * A result with quiescent=true attests all owned processes/tools have stopped; an interrupt ack cannot.
 * The result head is derived by the host from the staged tree, never from a model's final message.
 * usage describes the complete action, not the reserved allowance or partial observed usage.
 * Usage is immutable once observed; a drain result may change quiescence, not its usage record.
 *
 * Strict mode (Action schema 1): begin honors the action token ceiling. Known provider-receipt
 * references must identify retained accounting evidence for every request; local-no-model is zero
 * only and cannot be used for agent work. Unknown usage retains the full reservation.
 *
 * subscription-observed-v1 (Action schema 2): action.tokens is a planning charge, NOT a ceiling;
 * there is no hard aggregate token limit or overshoot bound. Agent results carry terminal
 * native-harness telemetry (reported, ambiguous-zero or unknown), never provider receipts;
 * absent/all-zero telemetry must not be reported as zero. Local actions report local-no-model.
 * capability must be null; qualification must equal the run's independently approved binding.
 *
 * These fields do not attest a provider or harness. Production adapters require independent
 * enforcement/containment qualification before admission.
 */
export interface CoordinatorTransport {
  versions: Versions;
  capability: HardLimitsCapability | null;
  qualification?: ExecutionQualification | null;
  begin(action: Readonly<Action>): Promise<Extract<Event, { type: "result" }>>;
  interrupt(action: Readonly<Action>): void;
}
