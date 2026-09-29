import { useCallback, useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { ConnectorReceiveScope } from '@dorkos/shared/connector-event-schemas';
import type { ConnectionId, ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import {
  useConnectorCatalog,
  useConnectorConnections,
  useResolveConnectorAgentRequest,
  useSessionConnectorConnections,
  useSetSessionConnectorAccess,
  serviceName as appServiceName,
  serviceLogo,
  type ServiceLogo,
} from '@/layers/entities/connectors';
import { Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { offerableAccounts } from '../../lib/readiness';
import { AccessCardFrame } from '../access/AccessCardFrame';
import { ConnectionAccessCard } from '../access/ConnectionAccessCard';
import { AgentRequestEventScopes } from '../AgentRequestEventScopes';
import { AccountAttentionStep } from './AccountAttentionStep';
import { RequestConnectStep } from './RequestConnectStep';
import { RequestReceipt } from './RequestReceipt';

/** Props for {@link AgentRequestCard}. */
export interface AgentRequestCardProps {
  /** One agent's request for an app, as the owner reads it. */
  request: ConnectorAgentRequestItem;
  /**
   * Open the exact per-action editor for an account, where the page has one.
   * A chat has nowhere to open it, so the card then says where to go instead.
   */
  onEditExactActions?: (connectionId: string) => void;
  /** Extra classes for the card. */
  className?: string;
}

/** Why "Not now" did not save. Declining writes nothing, so nothing changed. */
const DECLINE_FAILED = 'Couldn’t save your answer. Nothing changed. Try again.';

/** Whether an answer was refused because this chat has the app turned off. */
function refusedAsOffHere(error: Error | null): boolean {
  return (error as { code?: string } | null)?.code === 'session_access_off';
}

/** Why turning the app back on for this chat did not land. */
const TURN_ON_FAILED = 'Couldn’t turn it on for this chat. Nothing changed. Try again.';

/**
 * Why an Allow's answer did not reach the request after the access itself had
 * already been saved, and the one fix: send it again, turn the app back on for
 * this chat (only when the server's view of the chat offers it), choose the
 * updates again or answer without them, or nothing.
 */
function unansweredReason(
  error: Error | null,
  agentName: string,
  serviceName: string
): { reason: string; fix: 'retry' | 'turn_on' | 'updates' | null } {
  switch ((error as { code?: string } | null)?.code) {
    case 'session_access_off':
      // The chat's own switch is off. Turning it on is the same switch the
      // chat's details show: it only undoes that off, putting back the access
      // this chat had (its own hand-picked access, else what the agent has
      // everywhere), never more. The card offers it only when the chat's
      // readiness names it as the fix, then answers the request.
      return {
        reason: `this chat has ${serviceName} turned off for ${agentName}.`,
        fix: 'turn_on',
      };
    case 'request_already_resolved':
      return {
        reason: `it was already answered somewhere else, and ${agentName} got that answer. Ask ${agentName} again if it still needs this.`,
        fix: null,
      };
    case 'request_expired':
      return { reason: `the request ran out of time. Ask ${agentName} again.`, fix: null };
    case 'request_not_found':
      return { reason: 'the request is no longer open.', fix: null };
    case 'authority_sync_failed':
      return { reason: 'the access is still being set up.', fix: 'retry' };
    case 'event_selection_unavailable':
    case 'review_conflict':
    case 'destination_unavailable':
    case 'definition_changed':
    case 'invalid_filter':
      // Sending the same updates again would fail the same way, so the card
      // offers the two answers that can work instead of a retry.
      return {
        reason: `the updates you picked can’t be set up right now. Pick them again, or answer without updates.`,
        fix: 'updates',
      };
    case 'selection_invalid':
      return { reason: 'that account isn’t ready for it yet.', fix: 'retry' };
    default:
      return { reason: 'the answer didn’t reach the server.', fix: 'retry' };
  }
}

/**
 * The one way a person answers an agent's request for an app, in the
 * conversation where it asked and on the Connections page alike (DOR-2503):
 * connect the app if it has no account yet, fix the account if it is paused
 * or signed out, then "Let DorkBot use Gmail?" at the level it asked for, then
 * the updates it asked to hear about, if any, then a one-line record of the
 * answer.
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
export function AgentRequestCard({
  request,
  onEditExactActions,
  className,
}: AgentRequestCardProps) {
  const resolve = useResolveConnectorAgentRequest();
  const turnOn = useSetSessionConnectorAccess(request.sessionId);
  // Read the chat's own view only once the answer came back "turned off here":
  // whether turning it on is the fix is the server's call, not this card's.
  const offHere = refusedAsOffHere(resolve.error) ? request.sessionId : null;
  const chatAccess = useSessionConnectorConnections(offHere);
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
  // The updates that answer carried, so sending it again sends the same answer.
  const [answeredScopes, setAnsweredScopes] = useState<ConnectorReceiveScope[]>([]);
  // Once the access question is on screen it stays: the readiness gate below
  // only decides what shows BEFORE it. A save changes the account list, and
  // swapping the question out then would unmount the save that answers the
  // request.
  const [accessShown, setAccessShown] = useState(false);
  // The owner chose to connect the app again because the kept account's way
  // is down: the connect step shows even though that account still exists.
  const [connectingAgain, setConnectingAgain] = useState(false);
  // The account Allow saved access on, while the person picks the updates a
  // request asked to hear about. The answer waits for that choice.
  const [updatesFor, setUpdatesFor] = useState<string | null>(null);

  const decline = useCallback(() => {
    setAllowedId(null);
    resolve.mutate({ requestId: request.requestId, decision: { decision: 'denied' } });
  }, [resolve, request.requestId]);
  const answer = useCallback(
    (connectionId: string, eventScopes: ConnectorReceiveScope[] = []) => {
      setAllowedId(connectionId);
      setAnsweredScopes(eventScopes);
      resolve.mutate({
        requestId: request.requestId,
        decision: {
          decision: 'current_access',
          connectionId: connectionId as ConnectionId,
          eventScopes,
        },
      });
    },
    [resolve, request.requestId]
  );
  const wantsUpdates = request.requestedEvents.length > 0;
  const allowed = useCallback(
    (connectionId: string) => (wantsUpdates ? setUpdatesFor(connectionId) : answer(connectionId)),
    [answer, wantsUpdates]
  );

  const frameClass = cn('max-w-xl', className);

  if (allowedId && resolve.isError) {
    const { reason, fix } = unansweredReason(resolve.error, agentName, serviceName);
    const updatesFailed = fix === 'updates' && updatesFor !== null;
    const canTurnOn =
      fix === 'turn_on' &&
      chatAccess.data?.connections.find((row) => row.connectionId === allowedId)?.readiness.fix
        ?.action === 'turn_on_for_this_chat';
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
          {canTurnOn && ' Turning it on here only affects this chat.'}
        </p>
        {updatesFailed ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => answer(allowedId, [])}
              disabled={resolve.isPending}
            >
              Answer without updates
            </Button>
            <Button onClick={() => resolve.reset()} disabled={resolve.isPending}>
              Pick updates again
            </Button>
          </div>
        ) : (
          fix === 'retry' && (
            <div className="flex justify-end">
              <Button
                onClick={() => answer(allowedId, answeredScopes)}
                disabled={resolve.isPending}
              >
                {resolve.isPending ? 'Sending…' : 'Try again'}
              </Button>
            </div>
          )
        )}
        {canTurnOn && (
          <>
            {turnOn.isError && (
              <p role="alert" className="text-destructive text-sm">
                {TURN_ON_FAILED}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() =>
                  turnOn.mutate(
                    { connectionId: allowedId, on: true },
                    { onSuccess: () => answer(allowedId, answeredScopes) }
                  )
                }
                disabled={turnOn.isPending || resolve.isPending}
              >
                {turnOn.isPending || resolve.isPending ? 'Turning on…' : 'Turn on for this chat'}
              </Button>
            </div>
          </>
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

  // Access is saved; the request also asked to hear about new activity there.
  if (updatesFor) {
    return (
      <UpdatesStep
        key={updatesFor}
        request={request}
        connectionId={updatesFor}
        serviceName={serviceName}
        logo={serviceLogo(service)}
        onAnswer={(scopes) => answer(updatesFor, scopes)}
        deciding={resolve.isPending}
        className={frameClass}
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
      connection.toolkit === request.serviceSlug && connection.readiness.state !== 'gone'
  );
  const usable = offerableAccounts(all, request.serviceSlug);
  const showAccess = accessShown || Boolean(signedInId) || usable.length > 0;

  if (!showAccess && (connected.length === 0 || connectingAgain)) {
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
          serviceName={serviceName}
          logo={serviceLogo(service)}
          agentName={agentName}
          onDecline={decline}
          deciding={resolve.isPending}
          onConnectAgain={() => setConnectingAgain(true)}
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
          request={{ reason: request.reason, access: request.access }}
          {...(onEditExactActions ? { onEditExactActions } : {})}
          onSkip={decline}
          onAllowed={allowed}
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

/**
 * The updates step: the agent's access is saved, and its request also asked to
 * hear when something new happens in the app. The person picks where each
 * kind of update goes, or leaves updates out; either way the request is
 * answered here, never on another screen.
 */
function UpdatesStep({
  request,
  connectionId,
  serviceName,
  logo,
  onAnswer,
  deciding,
  className,
}: {
  request: ConnectorAgentRequestItem;
  connectionId: string;
  serviceName: string;
  logo: ServiceLogo;
  onAnswer: (scopes: ConnectorReceiveScope[]) => void;
  deciding: boolean;
  className: string;
}) {
  const [scopes, setScopes] = useState<ConnectorReceiveScope[] | null>(null);
  return (
    <AccessCardFrame
      titleId={`agent-request-updates-${request.requestId}`}
      toolkit={request.serviceSlug}
      serviceName={serviceName}
      logo={logo}
      title={`Send ${request.agent.displayName} updates from ${serviceName}?`}
      subtitle={`${request.agent.displayName} can now use ${serviceName}`}
      className={className}
    >
      <AgentRequestEventScopes
        connectionId={connectionId}
        requestedEvents={request.requestedEvents}
        agent={request.agent}
        onChange={setScopes}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onAnswer([])} disabled={deciding}>
          No updates
        </Button>
        <Button onClick={() => scopes && onAnswer(scopes)} disabled={deciding || !scopes}>
          {deciding ? 'Sending…' : 'Send updates'}
        </Button>
      </div>
    </AccessCardFrame>
  );
}
