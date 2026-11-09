import { Check, Clock3, ShieldOff } from 'lucide-react';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import { useAgentApprovals } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';
import { AgentApprovalLine } from './AgentApprovalLine';

/** What one answered request reads as, once it stops asking anything. */
function receiptLine(request: ConnectorAgentRequestItem, serviceName: string): string {
  const agent = request.agent.displayName;
  switch (request.status) {
    case 'granted':
      // Past tense on purpose: this record stays in the transcript, and access
      // can be changed later, so it says what was decided, not what holds now.
      return `Allowed ${agent} to use ${serviceName}`;
    case 'access_pending':
      return `Giving ${agent} access to ${serviceName}…`;
    case 'denied':
      return `${agent} wasn’t given ${serviceName}`;
    case 'expired':
      return `Request for ${serviceName} timed out. ${agent} can ask again.`;
    case 'authentication_failed':
      return `Signing in to ${serviceName} didn’t finish. Nothing was shared.`;
    case 'target_deleted':
      return `Request for ${serviceName} closed. The agent or its chat is gone.`;
    case 'awaiting_owner':
      return `${agent} is waiting for ${serviceName}`;
  }
}

/**
 * The one-line record an answered request leaves where it was asked: what was
 * decided, in the server's words, and nothing to press. It says "connected"
 * only once the server reports the access granted. A request another agent
 * approved says so, with that agent's avatar: the person didn't answer it,
 * so the receipt never reads as if they had.
 */
export function RequestReceipt({
  request,
  serviceName,
  className,
}: {
  request: ConnectorAgentRequestItem;
  serviceName: string;
  className?: string;
}) {
  const granted = request.status === 'granted';
  const pending = request.status === 'access_pending';
  const approvals = useAgentApprovals(granted);
  const approval = granted ? approvals.data?.get(request.requestId) : undefined;
  if (approval) {
    return (
      <p
        role="status"
        data-testid="agent-request-receipt"
        data-status={request.status}
        data-approved-by="agent"
        className={cn('bg-muted/40 rounded-lg px-3 py-2 text-sm', className)}
      >
        <AgentApprovalLine approval={approval} />
      </p>
    );
  }
  const Icon = granted ? Check : pending ? Clock3 : ShieldOff;
  return (
    <p
      role="status"
      data-testid="agent-request-receipt"
      data-status={request.status}
      className={cn(
        'bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
        className
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', granted && 'text-status-success')}
        aria-hidden
      />
      <span className={cn('min-w-0', granted && 'text-foreground')}>
        {receiptLine(request, serviceName)}
      </span>
    </p>
  );
}
