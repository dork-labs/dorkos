/**
 * Which tool families every agent gets (`agentContext`): read + mutate.
 *
 * Lives in the config entity rather than in either settings feature because two
 * sibling features need the same answer — the global Tools tab
 * (`features/settings`) turns a family on for everyone, and the per-agent Tools
 * tab (`features/agent-settings`) reads the same value to show what an agent
 * inherits. A hook one feature owns and the other reaches for is the
 * cross-feature coupling `.claude/rules/fsd-layers.md` forbids; an entity is
 * where it belongs.
 *
 * @module entities/config/model/use-agent-context-config
 */
import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';

/** The tool families an agent's context can carry. */
export interface AgentContextConfig {
  /** Relay messaging tools (send to a room, DM another agent). */
  relayTools: boolean;
  /** Mesh discovery tools (find and read other agents). */
  meshTools: boolean;
  /** Adapter tools (Telegram, Slack and friends). */
  adapterTools: boolean;
  /** Scheduled-task tools (create, run and inspect tasks). */
  tasksTools: boolean;
}

const DEFAULTS: AgentContextConfig = {
  relayTools: true,
  meshTools: true,
  adapterTools: true,
  tasksTools: true,
};

/**
 * Read and update the agentContext section of the user config.
 *
 * Uses the shared `configKeys.current()` query key so all config consumers
 * stay in sync after mutations.
 */
export function useAgentContextConfig() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const config: AgentContextConfig = {
    ...DEFAULTS,
    ...data?.agentContext,
  };

  const mutation = useMutation({
    mutationFn: (patch: Partial<AgentContextConfig>) =>
      transport.updateConfig({ agentContext: { ...config, ...patch } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });

  const updateConfig = useCallback(
    (patch: Partial<AgentContextConfig>) => {
      mutation.mutate(patch);
    },
    [mutation]
  );

  return { config, updateConfig };
}
