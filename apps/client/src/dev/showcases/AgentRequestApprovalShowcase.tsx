/**
 * One agent approving another's request for Read, as the person is asked when
 * the approver's Permissions area is set to Ask (Security S6 on #3572): who
 * asked, with their avatar, and the app; the request id behind ⓘ.
 *
 * @module dev/showcases/AgentRequestApprovalShowcase
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { ApprovalList } from '@/layers/features/approvals';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';

/** The agent asking for Linear, whose request another agent is approving. */
const REQUESTER = {
  id: 'agent-snapshot',
  name: 'flow-snapshot',
  displayName: 'Flow Snapshot',
  color: '#0ea5e9',
  icon: '📸',
};

/** Frozen at module load, so the countdown doesn't shift on every render. */
const LOADED_AT = Date.now();

const APPROVAL: PendingApproval = {
  approvalId: '01JZ0000000000000000000041',
  capabilityId: 'connectors.approve_request',
  capabilityTitle: 'Approve another agent’s request for Read',
  tier: 'act',
  area: 'permissions',
  requestedBy: 'DorkOS PM',
  hasAgentPath: true,
  alwaysOffered: false,
  subject: {
    kind: 'agent_request',
    label: 'Flow Snapshot · Linear',
    id: '01KXQ3P7ADJY9DSXMZW1XGWCV7',
  },
  summary:
    'DorkOS PM wants to run "Approve another agent’s request for Read" with request: "Flow Snapshot · Linear"',
  requestedAt: new Date(LOADED_AT).toISOString(),
  expiresAt: new Date(LOADED_AT + 105 * 60_000).toISOString(),
};

/** The playground transport, plus the request and agent the subject reads. */
function requesterTransport(): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'listMeshAgents') return async () => ({ agents: [REQUESTER] });
      if (prop === 'getConnectorAgentRequest') {
        return async (requestId: string) => ({
          requestId,
          agent: { id: REQUESTER.id, displayName: REQUESTER.displayName },
        });
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** The card, against a server that knows the request and the agent that asked. */
export function AgentRequestApprovalShowcase() {
  const transport = useMemo(() => requesterTransport(), []);
  const client = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ApprovalList approvals={[APPROVAL]} />
      </TransportProvider>
    </QueryClientProvider>
  );
}
