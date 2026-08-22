import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';

interface AgentContextConfig {
  relayTools: boolean;
  meshTools: boolean;
  adapterTools: boolean;
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
