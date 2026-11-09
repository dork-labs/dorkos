/**
 * Which agent requests another agent approved, so a request card can say who
 * answered it (spec `agent-grant-autonomy`, the DOR-3959 card). Read from the
 * person's own access-change ledger, where each approval names the request it
 * answered; the request itself only says it was granted.
 *
 * @module entities/connectors/model/use-agent-approvals
 */
import { useQuery } from '@tanstack/react-query';
import type { ConnectorAccessChange } from '@dorkos/shared/connector-exclusion-schemas';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * How many recent changes to read: the route's ceiling. A request answered
 * further back than that shows the plain receipt, which is still true.
 */
const RECENT_CHANGES = 200;

/** One agent's approval of another agent's request. */
export type AgentApproval = ConnectorAccessChange & { requestId: string };

/** Whether a ledger row is an agent's applied approval of a request. */
function isAgentApproval(change: ConnectorAccessChange): change is AgentApproval {
  return (
    change.kind === 'approve_read' &&
    change.outcome === 'applied' &&
    change.actorKind === 'agent' &&
    change.requestId !== null
  );
}

/**
 * Agents' approvals of requests, by the request each one answered. Only
 * applied approvals count: a refused one changed nothing, so its card still
 * waits on the person.
 *
 * @param enabled - Read only when a card could use it (a granted request).
 */
export function useAgentApprovals(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: connectorKeys.agentRequestApprovals(),
    enabled,
    queryFn: () => transport.listAccessChanges(RECENT_CHANGES),
    select: (changes): ReadonlyMap<string, AgentApproval> =>
      new Map(changes.filter(isAgentApproval).map((change) => [change.requestId, change] as const)),
    staleTime: 30_000,
  });
}
