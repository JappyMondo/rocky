import type { Versions } from "../store/index.js";
import type { Action, Event, HardLimitsCapability } from "./contracts.js";
/** Trusted host seam, not an agent tool or provider capability claim.
 * begin initiates synchronously, honors stable key/deadline/token ceiling and never retries internally.
 * A result with quiescent=true attests all owned processes/tools have stopped; an interrupt ack cannot.
 * usage describes the complete action, not the reserved allowance or partial observed usage.
 * Known provider-receipt references must identify retained accounting evidence for every request;
 * local-no-model is zero only and cannot be used for agent work. These fields do not attest a provider.
 * Unknown usage retains the full reservation and can settle local quiescence independently.
 * Usage is immutable once observed; a drain result may change quiescence, not its usage record.
 * Production adapters require independent enforcement/containment qualification before admission.
 */
export interface CoordinatorTransport {
  versions: Versions;
  capability: HardLimitsCapability | null;
  begin(action: Readonly<Action>): Promise<Extract<Event, { type: "result" }>>;
  interrupt(action: Readonly<Action>): void;
}
