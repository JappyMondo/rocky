import type { Versions } from "../store/index.js";
import type { Action, Event, HardLimitsCapability } from "./contracts.js";
/** Trusted host seam, not an agent tool or provider capability claim.
 * begin initiates synchronously, honors stable key/deadline/token ceiling and never retries internally.
 * A result with quiescent=true attests all owned processes/tools have stopped; an interrupt ack cannot.
 * Production adapters require independent enforcement/containment qualification before admission.
 */
export interface CoordinatorTransport {
  versions: Versions;
  capability: HardLimitsCapability | null;
  begin(action: Readonly<Action>): Promise<Extract<Event, { type: "result" }>>;
  interrupt(action: Readonly<Action>): void;
}
