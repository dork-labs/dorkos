/**
 * Heartbeat Transport method factory (spec `heartbeats` §7.6): what an agent's
 * Heartbeat page reads.
 *
 * @module shared/lib/transport/heartbeat-methods
 */
import type { HeartbeatStatus, TriageCreditsChoice } from '@dorkos/shared/heartbeat-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the heartbeat methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createHeartbeatMethods(baseUrl: string) {
  return {
    getAgentHeartbeat(agentId: string): Promise<HeartbeatStatus> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/heartbeat`);
    },
    chooseTriageCredits(useCredits: boolean): Promise<TriageCreditsChoice> {
      return fetchJSON(baseUrl, '/heartbeats/triage-credits', {
        method: 'PUT',
        body: JSON.stringify({ useCredits }),
      });
    },
  };
}
