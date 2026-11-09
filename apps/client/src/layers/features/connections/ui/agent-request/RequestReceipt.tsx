import { Check, Clock3, ShieldOff } from 'lucide-react';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { cn } from '@/layers/shared/lib';
import { AgentApprovalLine } from './AgentApprovalLine';

/** Who asked and for which app, with the asking agent's own avatar: "Flow Snapshot · Linear". */
function RequestHeader({
  request,
  serviceName,
}: {
  request: ConnectorAgentRequestItem;
  serviceName: string;
}) {
  const { data } = useRegisteredAgents();
  const asker = data?.agents.find((candidate) => candidate.id === request.agent.id);
  const visual = resolveAgentVisual(asker ?? { id: request.agent.id });
  return (
    <p data-slot="agent-request-header" className="flex min-w-0 items-center gap-1.5">
      <span data-slot="agent-request-asker" className="shrink-0">
        <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
      </span>
      <span className="text-foreground min-w-0 font-medium break-words">
        {`${request.agent.displayName} · ${serviceName}`}
      </span>
    </p>
  );
}

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
  // On the request itself, from its own approval row (Security M1 on #3575).
  const approval = granted ? request.approvedBy : undefined;
  if (approval) {
    // The card resolves in place: the request's own header stays (who asked, for which app), and
    // the answer goes under it, muted. The buttons go; the identity stays.
    return (
      <div
        role="status"
        data-testid="agent-request-receipt"
        data-status={request.status}
        data-approved-by="agent"
        className={cn('bg-muted/40 space-y-1 rounded-lg px-3 py-2 text-sm', className)}
      >
        <RequestHeader request={request} serviceName={serviceName} />
        <AgentApprovalLine approval={approval} className="text-muted-foreground text-xs" />
      </div>
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
