import { useRef, useState } from 'react';
import { Bell, MessageSquare, Trash2 } from 'lucide-react';
import type {
  ConnectionEventDefinitionPage,
  ConnectionEventSubscription,
} from '@dorkos/shared/connector-event-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  useConnectionEventDefinitions,
  useConnectionEventSource,
  useConnectionEventSubscriptions,
  useCreateConnectionEventSubscription,
  useDeleteConnectionEventSubscription,
} from '@/layers/entities/connectors';
import { useBindings } from '@/layers/entities/binding';
import { useMemberRooms, useTeamRoster } from '@/layers/entities/team';
import { useSafeNavigate } from '@/layers/shared/model';
import { cn, toSession } from '@/layers/shared/lib';
import { Button, Checkbox, QueryErrorState, Skeleton, Spinner } from '@/layers/shared/ui';
import { readEventFilterFields } from '../lib/event-filter-fields';
import { describeEventFilter, notificationStatus } from '../lib/notification-copy';
import {
  buildConnectionEventScope,
  connectionEventCadenceLabel,
  ConnectionEventScopeFields,
  emptyConnectionEventScopeDraft,
  type ConnectionEventScopeDraft,
} from './ConnectionEventScopeFields';
import {
  ConnectionEventSourceSetup,
  isConnectionEventSourceReady,
} from './ConnectionEventSourceSetup';

type ConnectionEventDefinition = ConnectionEventDefinitionPage['definitions'][number];
/** A roster member whose `kind` is `agent`. */
type AgentChoice = TeamMember;

/**
 * An agent's name, with its handle only when another agent shares the name, so
 * two rows never read the same while no id ever reaches the screen.
 */
function agentName(agents: AgentChoice[], agentId: string): string {
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) return 'an agent that’s no longer here';
  const shared = agents.some(
    (other) => other.id !== agent.id && other.displayName === agent.displayName
  );
  return shared && agent.handle ? `${agent.displayName} (@${agent.handle})` : agent.displayName;
}

/** Why a notification could not be set up, in words that point at the fix. */
function createErrorCopy(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const status = (error as { status?: number } | null)?.status;
  if (code === 'invalid_filter') return 'Check the filter values, then try again.';
  if (code === 'destination_unavailable')
    return 'This agent can’t get notifications there any more. Pick another place.';
  if (status === 409)
    return 'Something about this choice changed while you were picking it, or that place can’t take notifications any more. Check your choices, then try again.';
  return 'Couldn’t finish setting this up. Try again.';
}

function ConnectionNotificationRow({
  subscription,
  agents,
  definition,
  channelLabel,
  removing,
  onRemove,
}: {
  subscription: ConnectionEventSubscription;
  agents: AgentChoice[];
  definition?: ConnectionEventDefinition;
  channelLabel?: string;
  removing: boolean;
  onRemove: () => void;
}) {
  const navigate = useSafeNavigate();
  const rooms = useMemberRooms(subscription.agentId, {
    enabled: subscription.destination.kind === 'room',
  });
  const agent = agentName(agents, subscription.agentId);
  const room = rooms.data?.rooms.find((item) => item.id === subscription.destination.id);
  let destination = agent;
  let where = `Goes to ${agent}, all in one chat`;
  if (subscription.destination.kind === 'room') {
    destination = room ? (room.slug ? `#${room.slug}` : room.name) : 'a room this agent left';
    where = `Goes to ${destination}, for ${agent}`;
  } else if (subscription.destination.kind === 'channel') {
    destination = channelLabel ?? 'a chat app conversation that’s no longer set up';
    where = `Goes to ${destination}, for ${agent}`;
  }
  const filter = describeEventFilter(
    subscription.filter,
    definition ? readEventFilterFields(definition.filterSchema) : null
  );
  const status = notificationStatus(
    subscription,
    destination,
    connectionEventCadenceLabel(subscription)
  );
  const agentPath = agents.find((item) => item.id === subscription.agentId)?.agent?.projectPath;
  const chatSessionId = subscription.chatSessionId;
  const scopeLabel = filter ? `${where}. ${filter}` : where;

  return (
    <li
      className="bg-muted/40 flex min-h-11 items-start justify-between gap-2 rounded-lg px-3 py-2"
      data-state={subscription.state}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium break-words">{subscription.displayName}</p>
        <p className="text-muted-foreground text-xs break-words">{where}</p>
        {filter && <p className="text-muted-foreground text-xs break-words">{filter}</p>}
        <p
          className={cn(
            'text-xs break-words',
            status.tone === 'problem' ? 'text-destructive' : 'text-muted-foreground'
          )}
          data-testid="notification-status"
        >
          {status.text}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {chatSessionId && navigate && (
          <Button
            type="button"
            size="sm"
            variant={status.checkInChat ? 'secondary' : 'ghost'}
            className="gap-1.5"
            aria-label={`Open the chat for ${subscription.displayName}: ${scopeLabel}`}
            onClick={() =>
              void navigate(
                toSession({ session: chatSessionId, ...(agentPath && { dir: agentPath }) })
              )
            }
          >
            <MessageSquare className="size-3.5" aria-hidden />
            <span className="max-sm:sr-only">Open chat</span>
          </Button>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${subscription.displayName}: ${scopeLabel}`}
          aria-busy={removing}
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? <Spinner size="sm" /> : <Trash2 className="size-4" />}
        </Button>
      </div>
    </li>
  );
}

interface ConnectionNotificationsProps {
  connectionId: string;
}

/** Owner notification consent, destinations, and current subscriptions for one account. */
export function ConnectionNotifications({ connectionId }: ConnectionNotificationsProps) {
  return <ConnectionNotificationsForAccount key={connectionId} connectionId={connectionId} />;
}

function ConnectionNotificationsForAccount({ connectionId }: ConnectionNotificationsProps) {
  const source = useConnectionEventSource(connectionId, true);
  // Nothing is offered on a route that cannot deliver notifications: asking
  // for its activity would only fail a second time underneath the one line
  // that already says so.
  const offered = source.data !== undefined && source.data.setupMode !== 'unavailable';
  const definitions = useConnectionEventDefinitions(connectionId, offered);
  const subscriptions = useConnectionEventSubscriptions(connectionId);
  const roster = useTeamRoster();
  const bindings = useBindings();
  const createSubscription = useCreateConnectionEventSubscription();
  const deleteSubscription = useDeleteConnectionEventSubscription();
  const [draft, setDraft] = useState<ConnectionEventScopeDraft>(() =>
    emptyConnectionEventScopeDraft()
  );
  const [manageExistingTrigger, setManageExistingTrigger] = useState(false);
  // Per row: removing one notification leaves every other row's Remove usable.
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(() => new Set());
  const remove = (subscriptionId: string) => {
    setRemovingIds((ids) => new Set(ids).add(subscriptionId));
    deleteSubscription.mutate(
      { connectionId, subscriptionId },
      {
        onSettled: () =>
          setRemovingIds((ids) => {
            const next = new Set(ids);
            next.delete(subscriptionId);
            return next;
          }),
      }
    );
  };
  const decisionRef = useRef<{ signature: string; requestId: string } | null>(null);

  const definitionItems = definitions.data?.pages.flatMap((page) => page.definitions) ?? [];
  const subscriptionItems = subscriptions.data?.pages.flatMap((page) => page.subscriptions) ?? [];
  const agentChoices = (roster.data?.members ?? []).filter((member) => member.kind === 'agent');
  const scope = buildConnectionEventScope({ connectionId, definitions: definitionItems, draft });
  const sourceReady = source.data ? isConnectionEventSourceReady(source.data) : false;
  const canCreate = Boolean(scope && sourceReady);

  const resetDecision = () => {
    decisionRef.current = null;
    createSubscription.reset();
  };

  const updateDraft = (nextDraft: ConnectionEventScopeDraft) => {
    setDraft(nextDraft);
    resetDecision();
  };

  const submit = () => {
    if (!scope) return;
    const decision = {
      definitionId: scope.definitionId,
      filter: scope.filter,
      agentId: scope.agentId,
      destination: scope.destination,
      manageExistingTrigger,
    };
    const signature = JSON.stringify({ connectionId, decision });
    const prior = decisionRef.current;
    const requestId = prior?.signature === signature ? prior.requestId : crypto.randomUUID();
    decisionRef.current = { signature, requestId };
    createSubscription.mutate(
      { connectionId, input: { ...decision, requestId } },
      {
        onSuccess: () => {
          decisionRef.current = null;
          setDraft(emptyConnectionEventScopeDraft());
          setManageExistingTrigger(false);
        },
      }
    );
  };

  return (
    <section aria-labelledby="connection-notifications" className="space-y-4">
      <div className="space-y-1">
        <h3 id="connection-notifications" className="flex items-center gap-2 text-sm font-semibold">
          <Bell className="size-4" aria-hidden="true" />
          Tell an agent
        </h3>
        <p className="text-muted-foreground text-xs">
          Send new activity from this account to an agent, one of its rooms, or a chat app.
        </p>
      </div>

      {source.isPending ? (
        <Skeleton className="h-20 rounded-lg" aria-label="Loading delivery setup" />
      ) : source.isError ? (
        <QueryErrorState
          title="Couldn’t check whether this account can send notifications"
          description="Try again before adding one."
          onRetry={() => void source.refetch()}
          isRetrying={source.isFetching}
        />
      ) : source.data ? (
        <ConnectionEventSourceSetup connectionId={connectionId} status={source.data} />
      ) : null}

      {subscriptions.isPending ? (
        <Skeleton className="h-20 rounded-lg" aria-label="Loading notifications" />
      ) : subscriptions.isError ? (
        <QueryErrorState
          title="Couldn’t load notifications"
          description="Try again. Existing notifications were not changed."
          onRetry={() => void subscriptions.refetch()}
          isRetrying={subscriptions.isFetching}
        />
      ) : subscriptionItems.length === 0 ? (
        offered && <p className="bg-muted/40 rounded-lg p-3 text-sm">No notifications set up.</p>
      ) : (
        <div className="space-y-2" data-testid="connection-notification-list">
          <ul className="space-y-1.5">
            {subscriptionItems.map((subscription) => {
              const channel = bindings.data?.find(
                (binding) => binding.id === subscription.destination.id
              );
              return (
                <ConnectionNotificationRow
                  key={subscription.id}
                  subscription={subscription}
                  agents={agentChoices}
                  definition={definitionItems.find((item) => item.id === subscription.definitionId)}
                  channelLabel={channel ? channel.label || 'a chat app conversation' : undefined}
                  removing={removingIds.has(subscription.id)}
                  onRemove={() => remove(subscription.id)}
                />
              );
            })}
          </ul>
          {subscriptions.hasNextPage && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={subscriptions.isFetchingNextPage}
              onClick={() => void subscriptions.fetchNextPage()}
            >
              {subscriptions.isFetchingNextPage ? 'Loading…' : 'Load more notifications'}
            </Button>
          )}
        </div>
      )}
      {createSubscription.data &&
        !subscriptionItems.some((item) => item.id === createSubscription.data.id) && (
          <p className="bg-muted/40 rounded-lg p-3 text-sm" role="status">
            {createSubscription.data.state === 'pending'
              ? `${createSubscription.data.displayName} is being set up. DorkOS keeps trying on its own.`
              : `${createSubscription.data.displayName} is on.`}
          </p>
        )}
      {deleteSubscription.isError && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-foreground rounded-md border p-3 text-sm"
        >
          Couldn’t confirm that notification was removed. Check the list.
        </p>
      )}

      {offered && (
        <div className="space-y-3 rounded-lg border p-3" data-testid="notification-setup">
          <p className="text-sm font-medium">Add a notification</p>
          {definitions.isPending ? (
            <Skeleton className="h-20 rounded-md" aria-label="Loading available notifications" />
          ) : definitions.isError ? (
            <div className="flex flex-wrap items-center gap-x-2 text-sm">
              <p className="text-muted-foreground">
                Notifications aren’t available for this account right now.
              </p>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0"
                disabled={definitions.isFetching}
                onClick={() => void definitions.refetch()}
              >
                {definitions.isFetching ? 'Checking…' : 'Check again'}
              </Button>
            </div>
          ) : definitionItems.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This app doesn’t offer any notifications yet.
            </p>
          ) : roster.isPending ? (
            <Skeleton className="h-20 rounded-md" aria-label="Loading agents" />
          ) : roster.isError ? (
            <QueryErrorState
              title="Couldn’t load agents"
              description="Try again before choosing who should receive this activity."
              onRetry={() => void roster.refetch()}
              isRetrying={roster.isFetching}
            />
          ) : agentChoices.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Add an agent first. Notifications go to an agent.
            </p>
          ) : (
            <>
              <ConnectionEventScopeFields
                idPrefix="notification"
                definitions={definitionItems}
                draft={draft}
                onChange={updateDraft}
                agents={agentChoices}
                sourceStatus={source.data}
              />
              {source.data?.setupMode === 'byo_webhook' && (
                <div className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id="notification-manage-existing"
                    checked={manageExistingTrigger}
                    onCheckedChange={(checked) => {
                      setManageExistingTrigger(checked === true);
                      resetDecision();
                    }}
                  />
                  <label htmlFor="notification-manage-existing" className="text-sm">
                    If Composio already has a matching one, let DorkOS take it over
                  </label>
                </div>
              )}
              {createSubscription.isError && (
                <p role="alert" className="text-destructive text-sm">
                  {createErrorCopy(createSubscription.error)}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                disabled={!canCreate || createSubscription.isPending}
                onClick={submit}
              >
                {createSubscription.isPending ? 'Saving…' : 'Set up notification'}
              </Button>
            </>
          )}
          {definitions.hasNextPage && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={definitions.isFetchingNextPage}
              onClick={() => void definitions.fetchNextPage()}
            >
              {definitions.isFetchingNextPage ? 'Loading…' : 'Load more activity'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
