import { useCallback, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { ConnectionId, ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import {
  useConnectorCatalog,
  useConnectorConnections,
  useResolveConnectorAgentRequest,
} from '@/layers/entities/connectors';
import { Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { serviceNameFromSlug } from '../../lib/presentation';
import { AccessCardFrame } from '../access/AccessCardFrame';
import { ConnectionAccessCard } from '../access/ConnectionAccessCard';
import { RequestConnectStep } from './RequestConnectStep';
import { RequestReceipt } from './RequestReceipt';

/** Props for {@link AgentRequestCard}. */
export interface AgentRequestCardProps {
  /** One agent's request for an app, as the owner reads it. */
  request: ConnectorAgentRequestItem;
  /** Extra classes for the card. */
  className?: string;
}

/** Why an answer did not save, in words the person can act on. */
function decisionError(error: Error | null): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'request_expired') return 'This request ran out of time. Nothing changed.';
  if (code === 'authority_sync_failed') {
    return 'Access is still being set up. Try again in a moment.';
  }
  return 'Couldn’t save your answer. Nothing changed. Try again.';
}

/**
 * The card an agent's request for an app draws in the conversation where it
 * asked (connections-one-list design §3): connect the app if it has no account
 * yet, then "Let DorkBot use Gmail?", then a one-line record of the answer.
 *
 * Everything it shows is the server's state for this request, so a second
 * window, a reload and the Connections page all agree. It is always about the
 * ONE agent that asked: the access step is the shared card in one-agent mode,
 * which only ever raises that agent's access and never touches another. Only
 * the owner can read a request, so only the owner ever sees this card.
 *
 * Allow answers with the access the agent now holds; the agent's held turn
 * picks the answer up and carries on by itself. Not now answers no.
 */
export function AgentRequestCard({ request, className }: AgentRequestCardProps) {
  const resolve = useResolveConnectorAgentRequest();
  const connections = useConnectorConnections();
  const catalog = useConnectorCatalog(request.serviceSlug, request.status === 'awaiting_owner');
  const service =
    catalog.data?.pages
      .flatMap((page) => page.services)
      .find((candidate) => candidate.serviceSlug === request.serviceSlug) ?? null;
  const serviceName = service?.displayName ?? serviceNameFromSlug(request.serviceSlug);
  // The account a sign-in from this card just made; the access step skips the
  // "which account?" question for it.
  const [signedInId, setSignedInId] = useState<string | null>(null);

  const decline = useCallback(() => {
    resolve.mutate({ requestId: request.requestId, decision: { decision: 'denied' } });
  }, [resolve, request.requestId]);
  const allow = useCallback(
    (connectionId: string) => {
      resolve.mutate({
        requestId: request.requestId,
        decision: { decision: 'current_access', connectionId: connectionId as ConnectionId },
      });
    },
    [resolve, request.requestId]
  );

  const frameClass = cn('max-w-xl', className);
  if (request.status !== 'awaiting_owner') {
    return <RequestReceipt request={request} serviceName={serviceName} className={frameClass} />;
  }

  const failure = resolve.isError && (
    <p role="alert" className="text-destructive text-sm">
      {decisionError(resolve.error)}
    </p>
  );

  // Asking to hear about new activity needs the full review, which chooses the
  // exact events; the card does not pretend to answer it.
  if (request.requestedEvents.length > 0) {
    return (
      <EventRequestCard
        request={request}
        serviceName={serviceName}
        onDecline={decline}
        deciding={resolve.isPending}
        className={frameClass}
        failure={failure}
      />
    );
  }

  if (connections.isPending) {
    return <Skeleton className={cn('h-28 rounded-xl', frameClass)} aria-label="Loading accounts" />;
  }
  if (connections.isError) {
    return (
      <div className={frameClass}>
        <QueryErrorState
          title="Couldn’t load your accounts"
          description="Nothing changed. Try again."
          onRetry={() => void connections.refetch()}
          isRetrying={connections.isFetching}
        />
      </div>
    );
  }

  const hasAccount = (connections.data?.connections ?? []).some(
    (connection) =>
      connection.toolkit === request.serviceSlug && connection.lifecycle !== 'disconnected'
  );
  if (!hasAccount && !signedInId) {
    return (
      <div className={cn('space-y-2', frameClass)}>
        <RequestConnectStep
          request={request}
          serviceName={serviceName}
          service={service}
          onConnected={setSignedInId}
          onDecline={decline}
          deciding={resolve.isPending}
        />
        {failure}
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', frameClass)} data-testid="agent-request-access">
      <ConnectionAccessCard
        mode="agent"
        agentId={request.agent.id}
        toolkit={request.serviceSlug}
        serviceName={serviceName}
        {...(signedInId ? { connectionId: signedInId } : {})}
        onSkip={decline}
        onAllowed={allow}
      />
      {failure}
    </div>
  );
}

function EventRequestCard({
  request,
  serviceName,
  onDecline,
  deciding,
  className,
  failure,
}: {
  request: ConnectorAgentRequestItem;
  serviceName: string;
  onDecline: () => void;
  deciding: boolean;
  className: string;
  failure: React.ReactNode;
}) {
  return (
    <AccessCardFrame
      titleId={`agent-request-${request.requestId}`}
      toolkit={request.serviceSlug}
      title={`Let ${request.agent.displayName} use ${serviceName}?`}
      subtitle="It also wants to hear when something new happens there"
      className={className}
    >
      <p className="text-sm">
        <span className="text-muted-foreground">{request.agent.displayName} asked: </span>
        {request.reason}
      </p>
      <p className="text-muted-foreground text-sm">
        Choose which updates it gets on the full request.
      </p>
      {failure}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDecline} disabled={deciding}>
          Not now
        </Button>
        <Button asChild>
          <Link to="/connections" search={{ request: request.requestId }}>
            Review request
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </AccessCardFrame>
  );
}
