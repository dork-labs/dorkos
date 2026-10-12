/**
 * The heartbeat slice of the `Transport` interface (spec `heartbeats` §7.6),
 * joined in `transport-slices.ts`.
 *
 * @module shared/transport-heartbeats
 */
import type { HeartbeatStatus, TriageCreditsChoice } from './heartbeat-schemas.js';

/** What the app asks the server about an agent's heartbeat. */
export interface HeartbeatTransport {
  /**
   * How an agent wakes on its own, its next beat, its last beats from the
   * record, and the messages to people still held for their hours.
   *
   * @param agentId - The agent's Mesh id.
   */
  getAgentHeartbeat(agentId: string): Promise<HeartbeatStatus>;
  /**
   * Answer the one-time offer to run cheap checks on DorkOS credits (spec
   * `heartbeats` §6.3). Owner only; nothing is spent until the answer is yes.
   *
   * @param useCredits - `true` is **Use credits**; `false` is **Not now**.
   */
  chooseTriageCredits(useCredits: boolean): Promise<TriageCreditsChoice>;
}
