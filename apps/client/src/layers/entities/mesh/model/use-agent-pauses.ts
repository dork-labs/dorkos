/**
 * Which agents are paused everywhere, and pausing or resuming one (spec
 * `audit-trail` PR5).
 *
 * One query for the whole paused set, re-read when the server says it changed
 * (`agent_pauses_changed` on the unified event stream, followed by
 * `useAgentsSync` in the app shell), so a pause made in one window, by an
 * agent, or from the CLI shows in every window at once.
 *
 * @module entities/mesh/model/use-agent-pauses
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentPause } from '@dorkos/shared/mesh-schemas';
import { useTransport } from '@/layers/shared/model';

/** The query key for the paused set. */
export const AGENT_PAUSES_KEY = ['mesh', 'agent-pauses'] as const;

/** Every agent paused right now. */
export function useAgentPauses() {
  const transport = useTransport();
  return useQuery({
    queryKey: AGENT_PAUSES_KEY,
    queryFn: () => transport.listAgentPauses(),
    staleTime: 30_000,
  });
}

/**
 * The pause on one agent, or `null` when it is not paused (or not known yet).
 *
 * @param agentId - The agent's mesh id, or `null` to ask nothing.
 */
export function useAgentPause(agentId: string | null): AgentPause | null {
  const { data } = useAgentPauses();
  if (agentId === null) return null;
  return data?.pauses.find((pause) => pause.agentId === agentId) ?? null;
}

/** Pause an agent everywhere. */
export function usePauseAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { agentId: string; reason?: string }) =>
      transport.pauseAgent(opts.agentId, opts.reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENT_PAUSES_KEY }),
    meta: { errorLabel: 'Couldn’t pause the agent' },
  });
}

/** Lift an agent's pause. */
export function useResumeAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => transport.resumeAgent(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENT_PAUSES_KEY }),
    meta: { errorLabel: 'Couldn’t resume the agent' },
  });
}
