import { useRef, useState } from 'react';
import { Bell, Trash2 } from 'lucide-react';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { ConnectionEventSubscription } from '@dorkos/shared/connector-event-schemas';
import {
  useConnectionEventDefinitions,
  useConnectionEventSource,
  useConnectionEventSubscriptions,
  useCreateConnectionEventSubscription,
  useDeleteConnectionEventSubscription,
} from '@/layers/entities/connectors';
import { useBindings } from '@/layers/entities/binding';
import { useMemberRooms, useTeamRoster } from '@/layers/entities/team';
import { Badge, Button, Checkbox, QueryErrorState, Skeleton } from '@/layers/shared/ui';
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

function subscriptionStateVariant(
  state: ConnectionEventSubscription['state']
): 'secondary' | 'outline' | 'destructive' {
  if (state === 'active') return 'secondary';
  if (state === 'unavailable') return 'destructive';
  return 'outline';
}

function filterLabel(filter: Record<string, unknown>): string {
  if (Object.keys(filter).length === 0) return 'No filter';
  return `Filter ${stableStringify(filter)}`;
}

function destinationKindLabel(kind: ConnectionEventSubscription['destination']['kind']): string {
  if (kind === 'channel') return 'Messaging channel';
  return kind === 'room' ? 'Room' : 'Agent';
}

function namedIdentity(label: string | undefined, id: string): string {
  return label && label !== id ? `${label} (${id})` : id;
}

function ConnectionNotificationRow({
  subscription,
  agentLabel,
  destinationAgentLabel,
  channelLabel,
  removing,
  onRemove,
}: {
  subscription: ConnectionEventSubscription;
  agentLabel: string;
  destinationAgentLabel?: string;
  channelLabel?: string;
  removing: boolean;
  onRemove: () => void;
}) {
  const rooms = useMemberRooms(subscription.agentId, {
    enabled: subscription.destination.kind === 'room',
  });
  const room = rooms.data?.rooms.find((item) => item.id === subscription.destination.id);
  const destinationLabel =
    subscription.destination.kind === 'agent'
      ? (destinationAgentLabel ?? subscription.destination.id)
      : subscription.destination.kind === 'room'
        ? room
          ? namedIdentity(room.slug ? `#${room.slug}` : room.name, subscription.destination.id)
          : subscription.destination.id
        : (channelLabel ?? subscription.destination.id);
  const scopeLabel = `For ${agentLabel} · ${destinationKindLabel(subscription.destination.kind)} ${destinationLabel} · ${filterLabel(subscription.filter)}`;

  return (
    <li className="bg-muted/40 flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{subscription.displayName}</p>
        <p className="text-muted-foreground truncate text-xs">
          {connectionEventCadenceLabel(subscription)}
        </p>
        <p className="text-muted-foreground text-xs break-words">{scopeLabel}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge size="xs" variant={subscriptionStateVariant(subscription.state)}>
          {subscription.state}
        </Badge>
        {(subscription.state === 'active' || subscription.state === 'pending') && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${subscription.displayName}: ${scopeLabel}`}
            disabled={removing}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
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
  const definitions = useConnectionEventDefinitions(connectionId);
  const subscriptions = useConnectionEventSubscriptions(connectionId);
  const source = useConnectionEventSource(connectionId, true);
  const roster = useTeamRoster();
  const bindings = useBindings();
  const createSubscription = useCreateConnectionEventSubscription();
  const deleteSubscription = useDeleteConnectionEventSubscription();
  const [draft, setDraft] = useState<ConnectionEventScopeDraft>(() =>
    emptyConnectionEventScopeDraft()
  );
  const [manageExistingTrigger, setManageExistingTrigger] = useState(false);
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
          Notifications
        </h3>
        <p className="text-muted-foreground text-xs">
          Send selected account activity to an agent or a place they can reach.
        </p>
      </div>

      {source.isPending ? (
        <Skeleton className="h-20 rounded-lg" aria-label="Loading delivery setup" />
      ) : source.isError ? (
        <QueryErrorState
          title="Couldn’t load delivery setup"
          description="Try again before adding a notification."
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
        <p className="bg-muted/40 rounded-lg p-3 text-sm">No notifications set up.</p>
      ) : (
        <div className="space-y-2" data-testid="connection-notification-list">
          <ul className="space-y-1.5">
            {subscriptionItems.map((subscription) => {
              const agentLabel = namedIdentity(
                agentChoices.find((agent) => agent.id === subscription.agentId)?.displayName,
                subscription.agentId
              );
              const destinationAgent = agentChoices.find(
                (agent) => agent.id === subscription.destination.id
              );
              const channel = bindings.data?.find(
                (binding) => binding.id === subscription.destination.id
              );
              return (
                <ConnectionNotificationRow
                  key={subscription.id}
                  subscription={subscription}
                  agentLabel={agentLabel}
                  destinationAgentLabel={namedIdentity(
                    destinationAgent?.displayName,
                    subscription.destination.id
                  )}
                  channelLabel={namedIdentity(
                    channel?.label || channel?.chatId || undefined,
                    subscription.destination.id
                  )}
                  removing={deleteSubscription.isPending}
                  onRemove={() =>
                    deleteSubscription.mutate({ connectionId, subscriptionId: subscription.id })
                  }
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
            {createSubscription.data.displayName}{' '}
            {createSubscription.data.state === 'pending'
              ? 'setup is pending.'
              : `is ${createSubscription.data.state}.`}
          </p>
        )}
      {deleteSubscription.isError && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-foreground rounded-md border p-3 text-sm"
        >
          We couldn’t confirm whether that notification was removed. Check its current status before
          trying again.
        </p>
      )}

      <div className="space-y-3 rounded-lg border p-3" data-testid="notification-setup">
        <p className="text-sm font-medium">Add a notification</p>
        {definitions.isPending ? (
          <Skeleton className="h-20 rounded-md" aria-label="Loading available notifications" />
        ) : definitions.isError ? (
          <QueryErrorState
            title="Couldn’t load available notifications"
            description="Try again before choosing account activity."
            onRetry={() => void definitions.refetch()}
            isRetrying={definitions.isFetching}
          />
        ) : definitionItems.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This service does not report any account activity yet.
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
            Register an agent before setting up a notification.
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
                Replace an existing service notification if needed
              </label>
            </div>
            {createSubscription.isError && (
              <p role="alert" className="text-destructive text-sm">
                We couldn’t confirm this notification. Check its current state, then retry the same
                decision.
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
    </section>
  );
}
