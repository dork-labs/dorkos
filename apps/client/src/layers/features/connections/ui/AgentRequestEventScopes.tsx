import { useEffect, useMemo, useState } from 'react';
import type { ConnectorReceiveScope } from '@dorkos/shared/connector-event-schemas';
import {
  useConnectionEventDefinitions,
  useConnectionEventSource,
} from '@/layers/entities/connectors';
import { Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import {
  buildConnectionEventScope,
  ConnectionEventScopeFields,
  emptyConnectionEventScopeDraft,
  type ConnectionEventScopeDraft,
} from './ConnectionEventScopeFields';
import {
  ConnectionEventSourceSetup,
  isConnectionEventSourceReady,
} from './ConnectionEventSourceSetup';

function eventName(slug: string): string {
  const leaf = slug.split('.').at(-1) ?? slug;
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface AgentRequestEventScopesProps {
  connectionId: string;
  requestedEvents: string[];
  agent: { id: string; displayName: string };
  onChange: (scopes: ConnectorReceiveScope[] | null) => void;
}

/** Collect one complete exact receive scope for every event in an owner access request. */
export function AgentRequestEventScopes({
  connectionId,
  requestedEvents,
  agent,
  onChange,
}: AgentRequestEventScopesProps) {
  const definitions = useConnectionEventDefinitions(connectionId);
  const source = useConnectionEventSource(connectionId, true);
  const eventTypes = useMemo(() => [...new Set(requestedEvents)], [requestedEvents]);
  const [drafts, setDrafts] = useState<Record<string, ConnectionEventScopeDraft>>(() =>
    Object.fromEntries(
      eventTypes.map((eventType) => [eventType, emptyConnectionEventScopeDraft(agent.id)])
    )
  );
  const definitionItems = useMemo(
    () => definitions.data?.pages.flatMap((page) => page.definitions) ?? [],
    [definitions.data]
  );
  const scopes = useMemo(() => {
    if (!source.data || !isConnectionEventSourceReady(source.data)) return null;
    const complete = eventTypes.map((eventType) =>
      buildConnectionEventScope({
        connectionId,
        definitions: definitionItems.filter((definition) => definition.eventType === eventType),
        draft: drafts[eventType] ?? emptyConnectionEventScopeDraft(agent.id),
      })
    );
    return complete.every((scope): scope is ConnectorReceiveScope => scope !== null)
      ? complete
      : null;
  }, [agent.id, connectionId, definitionItems, drafts, eventTypes, source.data]);

  useEffect(() => onChange(scopes), [onChange, scopes]);

  return (
    <fieldset className="space-y-3" data-testid="agent-request-event-scopes">
      <legend className="text-sm font-medium">Notifications</legend>
      <p className="text-muted-foreground text-xs">
        Choose where this agent receives each requested kind of account activity.
      </p>

      {source.isPending ? (
        <Skeleton className="h-20 rounded-lg" aria-label="Loading delivery setup" />
      ) : source.isError ? (
        <QueryErrorState
          title="Couldn’t load delivery setup"
          description="Reload setup before deciding. No access was changed."
          onRetry={() => void source.refetch()}
          isRetrying={source.isFetching}
        />
      ) : source.data ? (
        <ConnectionEventSourceSetup
          connectionId={connectionId}
          status={source.data}
          idPrefix="agent-request-source"
        />
      ) : null}

      {definitions.isPending ? (
        <Skeleton className="h-28 rounded-lg" aria-label="Loading notification choices" />
      ) : definitions.isError ? (
        <QueryErrorState
          title="Couldn’t load notification choices"
          description="Reload the choices before deciding."
          onRetry={() => void definitions.refetch()}
          isRetrying={definitions.isFetching}
        />
      ) : (
        <div className="space-y-3">
          {eventTypes.map((eventType, index) => {
            const choices = definitionItems.filter(
              (definition) => definition.eventType === eventType
            );
            return (
              <section
                key={eventType}
                aria-labelledby={`agent-request-event-${index}`}
                className="bg-muted/30 space-y-3 rounded-lg p-3"
              >
                <div>
                  <h3 id={`agent-request-event-${index}`} className="text-sm font-medium">
                    {eventName(eventType)}
                  </h3>
                </div>
                {choices.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {definitions.hasNextPage
                      ? 'Load more notification options to finish this request.'
                      : 'This account does not currently offer this activity.'}
                  </p>
                ) : (
                  <ConnectionEventScopeFields
                    idPrefix={`agent-request-event-${index}`}
                    definitions={choices}
                    draft={drafts[eventType] ?? emptyConnectionEventScopeDraft(agent.id)}
                    onChange={(draft) =>
                      setDrafts((current) => ({ ...current, [eventType]: draft }))
                    }
                    fixedAgent={agent}
                    sourceStatus={source.data}
                  />
                )}
              </section>
            );
          })}
          {definitions.hasNextPage && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={definitions.isFetchingNextPage}
              onClick={() => void definitions.fetchNextPage()}
            >
              {definitions.isFetchingNextPage ? 'Loading…' : 'Load more notification options'}
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
