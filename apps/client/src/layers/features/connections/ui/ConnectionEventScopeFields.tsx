import { useMemo } from 'react';
import type {
  ConnectionEventDefinitionPage,
  ConnectionEventSourceStatus,
  ConnectorEventDestination,
  ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import { useBindings } from '@/layers/entities/binding';
import { useMemberRooms } from '@/layers/entities/team';
import { useRelayAdapters } from '@/layers/entities/relay';
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import {
  buildEventFilter,
  initialEventFilterValues,
  readEventFilterFields,
} from '../lib/event-filter-fields';

type ConnectionEventDefinition = ConnectionEventDefinitionPage['definitions'][number];
type DestinationKind = ConnectorEventDestination['kind'];

/** Controlled values for one exact notification receive scope. */
export interface ConnectionEventScopeDraft {
  definitionId: string;
  agentId: string;
  destinationKind: DestinationKind;
  destinationId: string;
  filterValues: Record<string, string | boolean>;
}

/** Construct a blank scope draft, optionally fixed to one requesting agent. */
export function emptyConnectionEventScopeDraft(agentId = ''): ConnectionEventScopeDraft {
  return {
    definitionId: '',
    agentId,
    destinationKind: 'agent',
    destinationId: '',
    filterValues: {},
  };
}

/** Describe actual or unknown provider delivery timing without inventing a cadence. */
export function connectionEventCadenceLabel(
  definition: Pick<ConnectionEventDefinition, 'deliveryMode' | 'expectedCadenceSeconds'>
): string {
  if (definition.deliveryMode === 'webhook') return 'Sent by the service when it happens';
  if (definition.deliveryMode === 'unknown') return 'Delivery timing is unavailable';
  if (definition.expectedCadenceSeconds === null) return 'Check timing is unavailable';
  if (definition.expectedCadenceSeconds < 60) {
    return `Checks about every ${definition.expectedCadenceSeconds} seconds`;
  }
  const minutes = Math.round(definition.expectedCadenceSeconds / 60);
  return `Checks about every ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** Resolve controlled owner choices to one complete exact scope, or null while incomplete. */
export function buildConnectionEventScope({
  connectionId,
  definitions,
  draft,
}: {
  connectionId: string;
  definitions: ConnectionEventDefinition[];
  draft: ConnectionEventScopeDraft;
}): ConnectorReceiveScope | null {
  const definition = definitions.find((item) => item.id === draft.definitionId);
  if (!definition || !draft.agentId) return null;
  const fields = readEventFilterFields(definition.filterSchema);
  if (!fields) return null;
  const filter = buildEventFilter(fields, draft.filterValues);
  if (!filter) return null;
  const destinationId = draft.destinationKind === 'agent' ? draft.agentId : draft.destinationId;
  if (!destinationId) return null;
  return {
    connectionId: connectionId as ConnectorReceiveScope['connectionId'],
    definitionId: definition.id,
    filter,
    agentId: draft.agentId,
    destination: { kind: draft.destinationKind, id: destinationId },
  };
}

interface EventAgentChoice {
  id: string;
  displayName: string;
}

/** Exact definition, agent, filter, and destination controls shared by owner consent flows. */
export function ConnectionEventScopeFields({
  idPrefix,
  definitions,
  draft,
  onChange,
  agents,
  fixedAgent,
  sourceStatus,
}: {
  idPrefix: string;
  definitions: ConnectionEventDefinition[];
  draft: ConnectionEventScopeDraft;
  onChange: (draft: ConnectionEventScopeDraft) => void;
  agents?: EventAgentChoice[];
  fixedAgent?: EventAgentChoice;
  sourceStatus?: ConnectionEventSourceStatus;
}) {
  const agentId = fixedAgent?.id ?? draft.agentId;
  const selectedDefinition = definitions.find((item) => item.id === draft.definitionId);
  const fields = selectedDefinition ? readEventFilterFields(selectedDefinition.filterSchema) : [];
  const rooms = useMemberRooms(agentId || null, { enabled: draft.destinationKind === 'room' });
  const bindings = useBindings();
  const relayAdapters = useRelayAdapters(draft.destinationKind === 'channel');
  const enabledAdapterIds = useMemo(
    () =>
      new Set(
        (relayAdapters.data ?? [])
          .filter((item) => item.config.enabled)
          .map((item) => item.config.id)
      ),
    [relayAdapters.data]
  );
  const channelOptions = useMemo(
    () =>
      (bindings.data ?? []).filter(
        (binding) =>
          binding.agentId === agentId &&
          binding.enabled &&
          binding.canInitiate &&
          Boolean(binding.chatId) &&
          enabledAdapterIds.has(binding.adapterId)
      ),
    [agentId, bindings.data, enabledAdapterIds]
  );

  const update = (next: Partial<ConnectionEventScopeDraft>) => {
    onChange({
      ...draft,
      ...next,
      ...(fixedAgent ? { agentId: fixedAgent.id } : {}),
    });
  };
  const selectDefinition = (definitionId: string) => {
    if (definitionId === draft.definitionId) return;
    const definition = definitions.find((item) => item.id === definitionId);
    const nextFields = definition ? readEventFilterFields(definition.filterSchema) : [];
    update({
      definitionId,
      filterValues: initialEventFilterValues(nextFields ?? []),
    });
  };
  const eventId = `${idPrefix}-event`;
  const agentInputId = `${idPrefix}-agent`;
  const destinationKindId = `${idPrefix}-destination-kind`;
  const roomId = `${idPrefix}-room`;
  const channelId = `${idPrefix}-channel`;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={eventId}>Account activity</Label>
        <Select value={draft.definitionId} onValueChange={selectDefinition}>
          <SelectTrigger id={eventId} aria-label="Account activity">
            <SelectValue placeholder="Choose activity" />
          </SelectTrigger>
          <SelectContent>
            {definitions.map((definition) => (
              <SelectItem key={definition.id} value={definition.id}>
                {definition.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedDefinition && (
          <p className="text-muted-foreground text-xs">
            {connectionEventCadenceLabel(selectedDefinition)}
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          {fixedAgent ? (
            <div>
              <p className="text-sm font-medium">Agent</p>
              <p id={agentInputId} className="bg-muted/40 mt-1 rounded-md px-3 py-2 text-sm">
                {fixedAgent.displayName}
              </p>
            </div>
          ) : (
            <>
              <Label htmlFor={agentInputId}>Agent</Label>
              <Select
                value={draft.agentId}
                onValueChange={(nextAgentId) => update({ agentId: nextAgentId, destinationId: '' })}
              >
                <SelectTrigger id={agentInputId} aria-label="Agent">
                  <SelectValue placeholder="Choose agent" />
                </SelectTrigger>
                <SelectContent>
                  {(agents ?? []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={destinationKindId}>Send to</Label>
          <Select
            value={draft.destinationKind}
            onValueChange={(destinationKind: DestinationKind) =>
              update({ destinationKind, destinationId: '' })
            }
          >
            <SelectTrigger id={destinationKindId} aria-label="Send to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="room">Room</SelectItem>
              <SelectItem value="channel">Messaging channel</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.destinationKind === 'room' && agentId && (
        <div className="space-y-1">
          <Label htmlFor={roomId}>Room</Label>
          <Select
            value={draft.destinationId}
            onValueChange={(destinationId) => update({ destinationId })}
          >
            <SelectTrigger id={roomId} aria-label="Room">
              <SelectValue placeholder="Choose one of this agent’s rooms" />
            </SelectTrigger>
            <SelectContent>
              {(rooms.data?.rooms ?? []).map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.slug ? `#${room.slug}` : room.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {rooms.isError ? (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="text-destructive text-xs">
                Couldn’t load this agent’s rooms.
              </p>
              <Button type="button" size="sm" variant="ghost" onClick={() => void rooms.refetch()}>
                Try again
              </Button>
            </div>
          ) : !rooms.isPending && (rooms.data?.rooms.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-xs">This agent is not in any rooms.</p>
          ) : null}
        </div>
      )}

      {draft.destinationKind === 'channel' && agentId && (
        <div className="space-y-1">
          <Label htmlFor={channelId}>Messaging channel</Label>
          <Select
            value={draft.destinationId}
            onValueChange={(destinationId) => update({ destinationId })}
          >
            <SelectTrigger id={channelId} aria-label="Messaging channel">
              <SelectValue placeholder="Choose a channel this agent can start" />
            </SelectTrigger>
            <SelectContent>
              {channelOptions.map((binding) => (
                <SelectItem key={binding.id} value={binding.id}>
                  {binding.label || binding.chatId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {bindings.isError || relayAdapters.isError ? (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="text-destructive text-xs">
                Couldn’t load this agent’s messaging channels.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void bindings.refetch();
                  void relayAdapters.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          ) : !bindings.isPending && !relayAdapters.isPending && channelOptions.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              This agent has no messaging channels that can start conversations.
            </p>
          ) : null}
        </div>
      )}

      {selectedDefinition && fields === null && (
        <p role="alert" className="text-muted-foreground rounded-md border p-3 text-sm">
          This notification needs filter controls this app cannot safely show yet.
        </p>
      )}
      {selectedDefinition?.deliveryMode === 'unknown' && (
        <p className="text-muted-foreground rounded-md border p-3 text-sm">
          This service has not reported its delivery timing. Setup may remain pending until it does.
        </p>
      )}
      {sourceStatus?.setupMode === 'byo_webhook' && !sourceStatus.configured && (
        <p className="text-muted-foreground text-xs">
          Save service delivery setup above before adding a notification.
        </p>
      )}
      {fields?.map((field) => {
        const filterId = `${idPrefix}-filter-${field.name}`;
        const examplesId = field.examples?.length ? `${filterId}-examples` : undefined;
        return (
          <div key={field.name} className="space-y-1">
            {field.type === 'boolean' ? (
              <div className="flex min-h-11 items-center gap-2">
                <Checkbox
                  id={filterId}
                  aria-describedby={examplesId}
                  checked={draft.filterValues[field.name] === true}
                  onCheckedChange={(checked) =>
                    update({
                      filterValues: {
                        ...draft.filterValues,
                        [field.name]: checked === true,
                      },
                    })
                  }
                />
                <Label htmlFor={filterId}>{field.label}</Label>
              </div>
            ) : field.options ? (
              <>
                <Label htmlFor={filterId}>{field.label}</Label>
                <Select
                  value={
                    typeof draft.filterValues[field.name] === 'string'
                      ? String(field.options.indexOf(String(draft.filterValues[field.name])))
                      : ''
                  }
                  onValueChange={(value) =>
                    update({
                      filterValues: {
                        ...draft.filterValues,
                        [field.name]: field.options![Number(value)]!,
                      },
                    })
                  }
                >
                  <SelectTrigger
                    id={filterId}
                    aria-label={field.label}
                    aria-describedby={examplesId}
                  >
                    <SelectValue placeholder={`Choose ${field.label.toLowerCase()}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option, index) => (
                      <SelectItem key={option} value={String(index)}>
                        {option === '' ? 'Leave blank' : option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <Label htmlFor={filterId}>{field.label}</Label>
                <Input
                  id={filterId}
                  type={field.type === 'string' ? 'text' : 'number'}
                  aria-describedby={examplesId}
                  required={
                    (field.required || field.defaultValue !== undefined) && field.type !== 'string'
                  }
                  step={field.type === 'integer' ? 1 : 'any'}
                  value={
                    typeof draft.filterValues[field.name] === 'string'
                      ? String(draft.filterValues[field.name])
                      : ''
                  }
                  onChange={(event) =>
                    update({
                      filterValues: {
                        ...draft.filterValues,
                        [field.name]: event.target.value,
                      },
                    })
                  }
                />
              </>
            )}
            {examplesId && (
              <p id={examplesId} className="text-muted-foreground text-xs break-words">
                Examples (not selected):{' '}
                {field.examples!.map((value) => JSON.stringify(value)).join(', ')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
