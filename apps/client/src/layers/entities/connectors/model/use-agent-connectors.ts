/**
 * Standing per-agent account attachment (connection-scoping spec §Part 1).
 *
 * An account attached to an agent stays attached: every session that agent
 * starts gets it, across restarts. A single session can still add or drop an
 * account just for itself, and that choice wins for that account.
 *
 * @module entities/connectors/model/use-agent-connectors
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentConnectorAttachment,
  AgentConnectorAttachResult,
} from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Read the accounts an agent has attached for good.
 *
 * @param agentId - The agent to read, or `null` to skip the request.
 */
export function useAgentConnectors(agentId: string | null) {
  const transport = useTransport();
  return useQuery<AgentConnectorAttachment[]>({
    queryKey: connectorKeys.agent(agentId ?? ''),
    queryFn: () => transport.getAgentConnectors(agentId ?? ''),
    enabled: agentId !== null && agentId !== '',
  });
}

/**
 * Attach an account to an agent for good. The result carries the custody
 * sentence again, because a standing attachment is its own consent point —
 * it outlives the session that prompted it.
 */
export function useAttachAgentConnector() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<AgentConnectorAttachResult, Error, { agentId: string; accountId: string }>({
    mutationFn: ({ agentId, accountId }) => transport.attachAgentConnector(agentId, accountId),
    meta: { errorLabel: "Couldn't attach the account" },
    onSuccess: (_result, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.agent(agentId) });
    },
  });
}

/**
 * Drop an agent's standing attachment. Sessions already running keep the
 * account's tools until they restart — the consent is withdrawn, the live
 * connection is not torn out from under a turn in flight.
 */
export function useDetachAgentConnector() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<void, Error, { agentId: string; accountId: string }>({
    mutationFn: ({ agentId, accountId }) => transport.detachAgentConnector(agentId, accountId),
    meta: { errorLabel: "Couldn't remove the account" },
    onSuccess: (_result, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.agent(agentId) });
    },
  });
}
