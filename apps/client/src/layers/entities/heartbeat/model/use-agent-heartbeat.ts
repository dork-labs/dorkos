import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { heartbeatKeys } from './heartbeat-keys';

/**
 * How often an open Heartbeat page re-reads. No event says a beat ended, so
 * the page polls, gently, while it is on screen.
 */
const LIVE_REFRESH_MS = 60_000;

/**
 * One agent's heartbeat. Anyone in the space may read any agent's.
 *
 * @param agentId - The agent's Mesh id, or null when there is none to ask about.
 * @param options - `live: true` re-reads every minute and on window focus, for
 *   the page itself; the profile row reads once.
 * @returns The TanStack Query result for `GET /api/agents/:id/heartbeat`.
 */
export function useAgentHeartbeat(agentId: string | null, options: { live?: boolean } = {}) {
  const transport = useTransport();
  return useQuery({
    queryKey: heartbeatKeys.agent(agentId ?? ''),
    queryFn: () => transport.getAgentHeartbeat(agentId!),
    enabled: agentId !== null,
    ...(options.live ? { refetchInterval: LIVE_REFRESH_MS, refetchOnWindowFocus: true } : {}),
  });
}
