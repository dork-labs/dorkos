import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { ConnectionId, ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import {
  useConnectorCatalog,
  useConnectorConnections,
  useResolveConnectorAgentRequest,
  serviceName as appServiceName,
  serviceLogo,
  type ServiceLogo,
} from '@/layers/entities/connectors';
import { Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { accountAttention, usableAccounts } from '../../lib/account-readiness';
import { AccessCardFrame } from '../access/AccessCardFrame';
import { ConnectionAccessCard } from '../access/ConnectionAccessCard';
import { AccountAttentionStep } from './AccountAttentionStep';
import { RequestConnectStep } from './RequestConnectStep';
import { RequestReceipt } from './RequestReceipt';

/** Props for {@link AgentRequestCard}. */
export interface AgentRequestCardProps {
  /** One agent's request for an app, as the owner reads it. */
  request: ConnectorAgentRequestItem;
  /** Extra classes for the card. */
  className?: string;
}

/** Why "Not now" did not save. Declining writes nothing, so nothing changed. */
const DECLINE_FAILED = 'Couldn’t save your answer. Nothing changed. Try again.';

/**
 * Why an Allow's answer did not reach the request after the access itself had
 * already been saved, and whether sending it again can help.
 */
function unansweredReason(
  error: Error | null,
  agentName: string,
  serviceName: string
): { reason: string; retry: boolean } {
  switch ((error as { code?: string } | null)?.code) {
    case 'session_access_off':
      // No screen in the app changes a single chat's access yet, so the card
      // says so rather than sending the person to a place without the control.
      return {
        reason: `this chat has ${serviceName} turned off for ${agentName}, and that can’t be changed from the app yet.`,
        retry: false,
      };
    case 'request_already_resolved':
      return {
        reason: `it was already answered somewhere else, and ${agentName} got that answer. Ask ${agentName} again if it still needs this.`,
        retry: false,
      };
    case 'request_expired':
      return { reason: `the request ran out of time. Ask ${agentName} again.`, retry: false };
    case 'request_not_found':
      return { reason: 'the request is no longer open.', retry: false };
    case 'authority_sync_failed':
      return { reason: 'the access is still being set up.', retry: true };
    case 'selection_invalid':
      return { reason: 'that account isn’t ready for it yet.', retry: true };
    default:
      return { reason: 'the answer didn’t reach the server.', retry: true };
  }
}

/**
 * The card an agent's request for an app draws in the conversation where it
 * asked (connections-one-list design §3): connect the app if it has no account
 * yet, fix the account if it is paused or signed out, then "Let DorkBot use
 * Gmail?", then a one-line record of the answer.
 *
 * Everything it shows is the server's state for this request, so a second
 * window, a reload and the Connections page all agree. It is always about the
 * ONE agent that asked: the access step is the shared card in one-agent mode,
 * which only ever raises that agent's access and never touches another. Only
 * the owner can read a request, so only the owner ever sees this card.
 *
 * Allow is two writes: the shared card saves the access, then the card answers
 * the request with it, and the agent's held turn picks the answer up. When the
 * second write fails the first has still landed, so the card says so and never
 * claims that nothing changed. Not now answers no.
 */
export function AgentRequestCard({ request, className }: AgentRequestCardProps) {
  const resolve = useResolveConnectorAgentRequest();
  const connections = useConnectorConnections();
  const catalog = useConnectorCatalog(request.serviceSlug, request.status === 'awaiting_owner');
  const service =
    catalog.data?.pages
      .flatMap((page) => page.services)
      .find((candidate) => candidate.serviceSlug === request.serviceSlug) ?? null;
  const serviceName = service?.displayName ?? appServiceName(request.serviceSlug);
  const agentName = request.agent.displayName;
  // The account a sign-in from this card just made; the access step skips the
  // "which account?" question for it.
  const [signedInId, setSignedInId] = useState<string | null>(null);
  // The account whose access Allow saved. Set before the answer is sent, so a
  // failed answer is reported as "saved, not answered", never "nothing changed".
  const [allowedId, setAllowedId] = useState<string | null>(null);
  // Once the access question is on screen it stays: the readiness gate below
  // only decides what shows BEFORE it. A save changes the account list, and
  // swapping the question out then would unmount the save that answers the
  // request.
  const [accessShown, setAccessShown] = useState(false);

  const decline = useCallback(() => {
    setAllowedId(null);
    resolve.mutate({ requestId: request.requestId, decision: { decision: 'denied' } });
  }, [resolve, request.requestId]);
  const answer = useCallback(
    (connectionId: string) => {
      setAllowedId(connectionId);
      resolve.mutate({
        requestId: request.requestId,
        decision: { decision: 'current_access', connectionId: connectionId as ConnectionId },
      });
    },
    [resolve, request.requestId]
  );

  const frameClass = cn('max-w-xl', className);

  if (allowedId && resolve.isError) {
    const { reason, retry } = unansweredReason(resolve.error, agentName, serviceName);
    return (
      <AccessCardFrame
        titleId={`agent-request-unanswered-${request.requestId}`}
        toolkit={request.serviceSlug}
        serviceName={serviceName}
        logo={serviceLogo(service)}
        title={`${agentName} can now use ${serviceName}`}
        className={frameClass}
      >
        <p role="alert" className="text-sm" data-testid="agent-request-unanswered">
          <Check
            className="text-status-success mr-1.5 inline size-4 align-text-bottom"
            aria-hidden
          />
          The access is saved, but {agentName}’s request wasn’t answered: {reason}
        </p>
        {retry && (
          <div className="flex justify-end">
            <Button onClick={() => answer(allowedId)} disabled={resolve.isPending}>
              {resolve.isPending ? 'Sending…' : 'Try again'}
            </Button>
          </div>
        )}
      </AccessCardFrame>
    );
  }

  if (request.status !== 'awaiting_owner') {
    return <RequestReceipt request={request} serviceName={serviceName} className={frameClass} />;
  }

  const declineFailure = resolve.isError && (
    <p role="alert" className="text-destructive text-sm">
      {DECLINE_FAILED}
    </p>
  );

  // Asking to hear about new activity needs the full review, which chooses the
  // exact events; the card does not pretend to answer it.
  if (request.requestedEvents.length > 0) {
    return (
      <EventRequestCard
        request={request}
        serviceName={serviceName}
        logo={serviceLogo(service)}
        onDecline={decline}
        deciding={resolve.isPending}
        className={frameClass}
        failure={declineFailure}
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

  const all = connections.data?.connections ?? [];
  const connected = all.filter(
    (connection) =>
      connection.toolkit === request.serviceSlug && connection.lifecycle !== 'disconnected'
  );
  const usable = usableAccounts(all, request.serviceSlug);
  const showAccess = accessShown || Boolean(signedInId) || usable.length > 0;

  if (!showAccess && connected.length === 0) {
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
        {declineFailure}
      </div>
    );
  }

  // Connected, but nothing an agent could use right now: fix that first.
  if (!showAccess) {
    const account = connected[0]!;
    return (
      <div className={cn('space-y-2', frameClass)}>
        <AccountAttentionStep
          account={account}
          attention={accountAttention(account) ?? { kind: 'needs_review' }}
          serviceName={serviceName}
          logo={serviceLogo(service)}
          agentName={agentName}
          onDecline={decline}
          deciding={resolve.isPending}
        />
        {declineFailure}
      </div>
    );
  }

  return (
    <AccessStepMount onShown={setAccessShown}>
      <div className={cn('space-y-2', frameClass)} data-testid="agent-request-access">
        <ConnectionAccessCard
          mode="agent"
          agentId={request.agent.id}
          toolkit={request.serviceSlug}
          serviceName={serviceName}
          logo={serviceLogo(service)}
          {...(signedInId ? { connectionId: signedInId } : {})}
          request={{ reason: request.reason, operations: request.requestedOperations }}
          onSkip={decline}
          onAllowed={answer}
        />
        {declineFailure}
      </div>
    </AccessStepMount>
  );
}

/** Marks the access question as shown the first time it mounts, so it stays. */
function AccessStepMount({
  onShown,
  children,
}: {
  onShown: (shown: true) => void;
  children: React.ReactNode;
}) {
  useEffect(() => onShown(true), [onShown]);
  return <>{children}</>;
}

function EventRequestCard({
  request,
  serviceName,
  logo,
  onDecline,
  deciding,
  className,
  failure,
}: {
  request: ConnectorAgentRequestItem;
  serviceName: string;
  logo: ServiceLogo;
  onDecline: () => void;
  deciding: boolean;
  className: string;
  failure: React.ReactNode;
}) {
  return (
    <AccessCardFrame
      titleId={`agent-request-${request.requestId}`}
      toolkit={request.serviceSlug}
      serviceName={serviceName}
      logo={logo}
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
