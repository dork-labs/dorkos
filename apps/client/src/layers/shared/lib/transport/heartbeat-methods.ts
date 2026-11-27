/**
 * Heartbeat Transport method factory (spec `heartbeats` §7.6): what an agent's
 * Heartbeat page reads, through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/heartbeat-methods
 */
import type { HeartbeatStatus, TriageCreditsChoice } from '@dorkos/shared/heartbeat-schemas';
import type { WakersOff } from '@dorkos/shared/waker-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the heartbeat methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createHeartbeatMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // The document also lists each capability's 202 approval answer, which a
    // person's own call never gets; the casts keep today's types.
    async getAgentHeartbeat(agentId: string): Promise<HeartbeatStatus> {
      return (await api.call('heartbeat.view_page', { path: { agentId } })) as HeartbeatStatus;
    },
    async chooseTriageCredits(useCredits: boolean): Promise<TriageCreditsChoice> {
      return (await api.call('heartbeat.choose_triage_credits', {
        body: { useCredits },
      })) as TriageCreditsChoice;
    },
    async listWakersOff(): Promise<WakersOff> {
      return (await api.call('heartbeat.wakers_off', {})) as WakersOff;
    },
  };
}
