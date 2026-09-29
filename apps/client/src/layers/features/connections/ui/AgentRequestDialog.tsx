import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Clock3, ShieldAlert } from 'lucide-react';
import type { ConnectorReceiveScope } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  actionNameFromSlug,
  type ConnectionId,
  type ConnectorAgentRequestItem,
} from '@dorkos/shared/connector-schemas';
import {
  useConnectorAgentRequest,
  useConnectorCatalog,
  useConnectorConnection,
  useConnectorConnections,
  usePreviewConnectorReconciliation,
  useResolveConnectorAgentRequest,
  serviceName,
} from '@/layers/entities/connectors';
import {
  Badge,
  Button,
  Checkbox,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import { offerableAccounts } from '../lib/readiness';
import { AgentRequestEventScopes } from './AgentRequestEventScopes';

function requestStateLabel(status: ConnectorAgentRequestItem['status']): string {
  switch (status) {
    case 'awaiting_owner':
      return 'Needs your review';
    case 'access_pending':
      return 'Access pending';
    case 'granted':
      return 'Granted';
    case 'denied':
      return 'Denied';
    case 'expired':
      return 'Expired';
    case 'authentication_failed':
      return 'Account setup failed';
    case 'target_deleted':
      return 'No longer available';
  }
}

/**
 * One agent's request to use an app: which account, which exact actions, and
 * the owner's decision. Opened from the page's "Needs you" strip or a
 * `?request=` deep link.
 */
export function AgentRequestDialog({
  requestId,
  open,
  onOpenChange,
  onConnectService,
  onCloseAutoFocus,
}: {
  /** The request to show. */
  requestId: string | null;
  /** Whether the dialog is open (closed while its sign-in dialog is in front). */
  open: boolean;
  /** Close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Open the sign-in flow for the exact app the agent asked for. */
  onConnectService: (service: ConnectorCatalogService) => void;
  /**
   * Where focus goes once the dialog closes. The opener can be gone by then
   * (a decided request leaves the "Needs you" strip), so the page decides.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const request = useConnectorAgentRequest(requestId);
  const connections = useConnectorConnections();
  const catalog = useConnectorCatalog(
    request.data?.serviceSlug ?? '',
    open && Boolean(request.data)
  );
  const resolve = useResolveConnectorAgentRequest();
  const preview = usePreviewConnectorReconciliation();
  const [connectionId, setConnectionId] = useState('');
  const [operationRevisionIds, setOperationRevisionIds] = useState<string[]>([]);
  const [eventScopeState, setEventScopeState] = useState<{
    selectionKey: string;
    scopes: ConnectorReceiveScope[] | null;
  }>({ selectionKey: '', scopes: null });
  const connection = useConnectorConnection(connectionId || null);

  const matchingConnections = useMemo(
    () =>
      request.data
        ? offerableAccounts(connections.data?.connections ?? [], request.data.serviceSlug)
        : [],
    [connections.data?.connections, request.data?.serviceSlug]
  );
  const catalogService = catalog.data?.pages
    .flatMap((page) => page.services)
    .find((service) => service.serviceSlug === request.data?.serviceSlug);

  useEffect(() => {
    if (!open || request.data?.status !== 'awaiting_owner') return;
    const next = matchingConnections.some((candidate) => candidate.connectionId === connectionId)
      ? connectionId
      : (matchingConnections[0]?.connectionId ?? '');
    setConnectionId(next);
  }, [connectionId, matchingConnections, open, request.data?.status]);

  useEffect(() => {
    if (!open || !connectionId || request.data?.status !== 'awaiting_owner') return;
    const requestedOperationSlugs = request.data.requestedOperations;
    preview.reset();
    preview.mutate(
      { connectionId },
      {
        onSuccess: (result) => {
          const requested = new Set(requestedOperationSlugs);
          setOperationRevisionIds(
            result.candidates
              .filter(
                (candidate) =>
                  requested.has(candidate.operationSlug) &&
                  candidate.supported &&
                  candidate.capabilityClassification !== 'destructive'
              )
              .map((candidate) => candidate.operationRevisionId)
          );
        },
      }
    );
    // The mutation object changes with its result; this effect is keyed only to
    // the exact account/request selection that needs a new immutable preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, open, request.data?.requestId, request.data?.status]);

  const requestedOperations = useMemo(() => {
    if (!preview.data || !request.data) return [];
    const requested = new Set(request.data.requestedOperations);
    return preview.data.candidates.filter((candidate) => requested.has(candidate.operationSlug));
  }, [preview.data, request.data]);
  const hasEventRequest = Boolean(request.data?.requestedEvents.length);
  const eventSelectionKey = `${request.data?.requestId ?? ''}:${connectionId}`;
  const eventScopes = hasEventRequest
    ? eventScopeState.selectionKey === eventSelectionKey
      ? eventScopeState.scopes
      : null
    : [];
  const acceptEventScopes = useCallback(
    (scopes: ConnectorReceiveScope[] | null) => {
      setEventScopeState({ selectionKey: eventSelectionKey, scopes });
    },
    [eventSelectionKey]
  );
  const canApprove =
    request.data?.status === 'awaiting_owner' &&
    connectionId !== '' &&
    operationRevisionIds.length > 0 &&
    eventScopes !== null &&
    !preview.isPending &&
    !resolve.isPending;

  const deny = () => {
    if (!requestId) return;
    resolve.mutate({ requestId, decision: { decision: 'denied' } });
  };
  const approve = () => {
    if (!requestId || !canApprove) return;
    resolve.mutate({
      requestId,
      decision: {
        decision: 'approved',
        connectionId: connectionId as ConnectionId,
        operationRevisionIds,
        eventScopes: eventScopes ?? [],
      },
    });
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="agent-request-dialog"
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[90vh] sm:max-w-2xl [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Review agent access</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Choose one account and only the actions this agent needs.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 pb-4">
          {request.isPending ? (
            <div aria-label="Loading agent request" className="space-y-3">
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          ) : request.isError ? (
            <QueryErrorState
              title="Couldn’t load this request"
              description="Try again. No access was changed."
              onRetry={() => void request.refetch()}
              isRetrying={request.isFetching}
            />
          ) : request.data ? (
            <>
              <div className="bg-muted/40 rounded-lg p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{request.data.agent.displayName}</p>
                  <Badge size="xs" variant="outline">
                    {serviceName(request.data.serviceSlug)}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-2 text-sm">{request.data.reason}</p>
              </div>

              {request.data.status !== 'awaiting_owner' ? (
                <RequestOutcome request={request.data} />
              ) : connections.isError ? (
                <QueryErrorState
                  title="Couldn’t load your accounts"
                  description="Try again before deciding. No access was changed."
                  onRetry={() => void connections.refetch()}
                  isRetrying={connections.isFetching}
                />
              ) : matchingConnections.length === 0 ? (
                <div className="border-border space-y-3 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Connect an account first</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Signing in does not grant access. You will return here to choose actions.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!catalogService}
                    onClick={() => catalogService && onConnectService(catalogService)}
                  >
                    {catalogService ? `Connect ${catalogService.displayName}` : 'Loading service…'}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label htmlFor="agent-request-account" className="text-sm font-medium">
                      Account
                    </label>
                    <Select value={connectionId} onValueChange={setConnectionId}>
                      <SelectTrigger id="agent-request-account" data-testid="agent-request-account">
                        <SelectValue placeholder="Choose an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {matchingConnections.map((candidate) => (
                          <SelectItem key={candidate.connectionId} value={candidate.connectionId}>
                            {candidate.label}
                            {candidate.identityHint ? ` · ${candidate.identityHint}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {connection.data && (
                      <p
                        className="text-muted-foreground text-xs"
                        data-testid="agent-request-custody"
                      >
                        {connection.data.provider.disclosure}
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!catalogService}
                      onClick={() => catalogService && onConnectService(catalogService)}
                    >
                      Use another account
                    </Button>
                  </div>

                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Allowed actions</legend>
                    <p className="text-muted-foreground text-xs">
                      Read and write actions start selected. Destructive actions need a separate
                      choice.
                    </p>
                    {preview.isPending ? (
                      <Skeleton className="h-28 rounded-lg" />
                    ) : preview.isError ? (
                      <QueryErrorState
                        title="Couldn’t load service actions"
                        description="Reload the current actions before deciding."
                        onRetry={() => connectionId && preview.mutate({ connectionId })}
                        isRetrying={preview.isPending}
                      />
                    ) : requestedOperations.length === 0 ? (
                      <p role="alert" className="bg-muted/40 rounded-lg p-4 text-sm">
                        None of the requested actions are currently available on this account.
                      </p>
                    ) : (
                      <ul className="space-y-2" data-testid="agent-request-actions">
                        {requestedOperations.map((candidate) => {
                          const checked = operationRevisionIds.includes(
                            candidate.operationRevisionId
                          );
                          return (
                            <li
                              key={candidate.operationRevisionId}
                              className="bg-muted/40 flex items-start gap-3 rounded-lg p-3"
                            >
                              <Checkbox
                                checked={checked}
                                disabled={!candidate.supported}
                                aria-label={actionNameFromSlug(
                                  candidate.operationSlug,
                                  candidate.toolkit
                                )}
                                onCheckedChange={(next) =>
                                  setOperationRevisionIds((current) =>
                                    next === true
                                      ? [...new Set([...current, candidate.operationRevisionId])]
                                      : current.filter((id) => id !== candidate.operationRevisionId)
                                  )
                                }
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                  {actionNameFromSlug(candidate.operationSlug, candidate.toolkit)}
                                  <Badge
                                    size="xs"
                                    variant={
                                      candidate.capabilityClassification === 'destructive'
                                        ? 'destructive'
                                        : 'secondary'
                                    }
                                  >
                                    {candidate.capabilityClassification}
                                  </Badge>
                                </span>
                                {!candidate.supported && (
                                  <span className="text-muted-foreground mt-0.5 block text-xs">
                                    No longer available
                                  </span>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </fieldset>

                  {hasEventRequest && (
                    <AgentRequestEventScopes
                      key={eventSelectionKey}
                      connectionId={connectionId}
                      requestedEvents={request.data.requestedEvents}
                      agent={request.data.agent}
                      onChange={acceptEventScopes}
                    />
                  )}
                </>
              )}

              {resolve.isError && (
                <p role="alert" className="text-destructive text-sm">
                  We couldn’t save this decision. Reload the request before trying again.
                </p>
              )}
            </>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {request.data?.status === 'awaiting_owner' && (
            <>
              <Button variant="outline" onClick={deny} disabled={resolve.isPending}>
                Deny
              </Button>
              <Button onClick={approve} disabled={!canApprove}>
                {resolve.isPending ? 'Saving…' : 'Grant access'}
              </Button>
            </>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function RequestOutcome({ request }: { request: ConnectorAgentRequestItem }) {
  const pending = request.status === 'access_pending';
  const granted = request.status === 'granted';
  const Icon = pending ? Clock3 : granted ? Check : ShieldAlert;
  return (
    <div
      className="border-border flex items-start gap-3 rounded-lg border p-4"
      data-testid="agent-request-outcome"
    >
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <p className="text-sm font-medium">{requestStateLabel(request.status)}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          {pending
            ? 'New access remains unavailable until synchronization finishes.'
            : granted
              ? 'Access is ready for this agent.'
              : 'No new access was granted.'}
        </p>
      </div>
    </div>
  );
}
