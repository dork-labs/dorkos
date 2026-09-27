import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type {
  ConnectorAuthenticationFlowState,
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAuthentication,
  useConnectorAgentRequestAuthentication,
  useConnectorCatalog,
  useStartConnectorAuthentication,
  useStartConnectorAgentRequestAuthentication,
} from '@/layers/entities/connectors';
import {
  Button,
  ExternalLinkAnchor,
  Input,
  Label,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  accountRoutes,
  chooseConnectRoute,
  firstConnectReason,
  isCatalogOutage,
  needsFirstConnectStep,
  signInLine,
  wayName,
} from '../lib/connect-route';
import { FirstConnectStep } from './FirstConnectStep';
import { ConnectionAccessCard } from './access/ConnectionAccessCard';

interface ConnectDialogProps {
  /** Service selected from the account-free catalog. */
  service: ConnectorCatalogService | null;
  /** Opaque durable flow id stored in the current URL. */
  flowId: string | null;
  /** Exact agent request this authentication flow must remain associated with. */
  agentRequestId?: string | null;
  /** Writes or clears the URL-backed flow identity. */
  onFlowIdChange: (flowId: string | null) => void;
  /** Clears the transient service selection after the dialog closes. */
  onClose: () => void;
  /**
   * Opens the exact per-action access editor for the newly connected account,
   * or hands a request-bound connection back to its request.
   */
  onChooseAccess: (connectionId: string) => void;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function authenticationGuidance(
  route: ConnectorCatalogProviderRoute,
  serviceName: string
): string | null {
  const setup = route.authenticationSetup;
  if (!setup) return null;
  if (setup.source === 'configured') {
    return `This ${serviceName} connection uses the custom sign-in setup configured for this service.`;
  }
  if (setup.kind === 'oauth') {
    return `Continue to Composio to approve access to ${serviceName}.`;
  }
  if (setup.kind === 'fields' && route.mode === 'managed') {
    return `Enter the account details requested by ${serviceName} on dorkos.ai. DorkOS passes them to Composio without saving them.`;
  }
  if (setup.kind === 'none' && route.mode === 'managed') {
    return `Review and confirm this ${serviceName} connection on dorkos.ai. No account details are needed.`;
  }
  return null;
}

function authenticationAction(
  route: ConnectorCatalogProviderRoute | null,
  stage: 'start' | 'authorize'
): string {
  if (route?.mode === 'managed' && route.authenticationSetup?.kind === 'fields')
    return 'Enter account details';
  if (route?.mode === 'managed' && route.authenticationSetup?.kind === 'none')
    return 'Review and confirm';
  if (route?.authenticationSetup?.source === 'configured') return 'Continue';
  if (stage === 'authorize') return 'Open sign-in';
  return route?.authKind === 'none' ? 'Check connection' : 'Continue';
}

/** Durable service authentication flow with provider disclosure before authorization. */
export function ConnectDialog({
  service,
  flowId,
  agentRequestId = null,
  onFlowIdChange,
  onClose,
  onChooseAccess,
}: ConnectDialogProps) {
  const [open, setOpen] = useState(Boolean(service || flowId));
  const [label, setLabel] = useState('');
  const [routeOverride, setRouteOverride] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const standaloneStart = useStartConnectorAuthentication();
  const requestStart = useStartConnectorAgentRequestAuthentication(agentRequestId);
  const standaloneFlow = useConnectorAuthentication(agentRequestId ? null : flowId);
  const requestFlow = useConnectorAgentRequestAuthentication(agentRequestId, flowId);
  const start = agentRequestId ? requestStart : standaloneStart;
  const flow = agentRequestId ? requestFlow : standaloneFlow;
  const serviceSlug = flow.data?.toolkit ?? service?.serviceSlug ?? '';
  const lookup = useConnectorCatalog(serviceSlug);
  // The fresh read wins over the row the list handed in, so a way set up in
  // the one-time step shows its routes here without reopening the dialog.
  const lookedUpService = lookup.data?.pages
    .flatMap((page) => page.services)
    .find((candidate) => candidate.serviceSlug === serviceSlug);
  const firstPage = lookup.data?.pages[0];
  const appConnections = firstPage?.appConnections;
  const resolvedService = lookedUpService ?? service ?? null;
  const routes = accountRoutes(resolvedService);
  const availableRouteCount = routes.filter(
    (candidate) => candidate.capabilities.authentication.status === 'available'
  ).length;
  const route =
    routes.find((candidate) => candidate.providerInstanceId === routeOverride) ??
    (flow.data
      ? routes.find((candidate) => candidate.providerInstanceId === flow.data.providerInstanceId)
      : null) ??
    chooseConnectRoute(routes, appConnections?.newApps);
  const activeFlow: ConnectorAuthenticationFlowState | undefined = flow.data ?? start.data;
  const firstConnect = !activeFlow && needsFirstConnectStep(resolvedService);

  const serviceName = resolvedService?.displayName ?? titleCase(activeFlow?.toolkit ?? 'service');
  const guidance = route ? authenticationGuidance(route, serviceName) : null;
  const whoAsks = signInLine(route, resolvedService);
  const close = () => {
    setOpen(false);
    onClose();
  };

  /** Leave a finished connection: forget its flow and close. */
  const finish = () => {
    onFlowIdChange(null);
    close();
  };

  const begin = () => {
    if (!resolvedService || !route) return;
    const common = {
      providerInstanceId: route.providerInstanceId,
      ...(label.trim() && { label: label.trim() }),
    };
    if (agentRequestId) {
      requestStart.mutate(common, { onSuccess: (result) => onFlowIdChange(result.flowId) });
    } else {
      standaloneStart.mutate(
        {
          ...common,
          toolkit: resolvedService.serviceSlug,
          idempotencyKey: crypto.randomUUID(),
        },
        { onSuccess: (result) => onFlowIdChange(result.flowId) }
      );
    }
  };

  const terminal =
    activeFlow?.state === 'connected' ||
    activeFlow?.state === 'failed' ||
    activeFlow?.state === 'expired' ||
    activeFlow?.state === 'start_unknown';

  return (
    <>
      {!open && flowId && !terminal && (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Resume {serviceName} connection
        </Button>
      )}
      <ResponsiveDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
          else setOpen(true);
        }}
      >
        <ResponsiveDialogContent
          data-testid="connect-auth-dialog"
          className={cn(
            'max-h-[90vh] sm:max-w-lg [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100',
            // The one-time step is short; the dialog's default half-screen floor
            // would leave a blank band above Cancel.
            firstConnect && 'min-h-0'
          )}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Connect {serviceName}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {activeFlow
                ? 'Finish this connection, then choose which agents may use it.'
                : firstConnect
                  ? 'First, pick how DorkOS reaches your apps. Once a way works, Connect goes straight to sign-in.'
                  : 'Name the account and review who handles its sign-in.'}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-4 pb-4">
            {firstConnect &&
            routes.length === 0 &&
            isCatalogOutage(firstPage) &&
            appConnections?.newApps.status === 'ready' ? (
              <QueryErrorState
                title={`Couldn’t reach ${serviceName} just now`}
                description={`${wayName(appConnections.newApps.way)} didn’t answer. Nothing needs setting up — try again in a moment.`}
                onRetry={() => void lookup.refetch()}
                isRetrying={lookup.isFetching}
              />
            ) : firstConnect ? (
              <FirstConnectStep reason={firstConnectReason(appConnections, resolvedService)} />
            ) : !activeFlow ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="connection-label">Account label</Label>
                  <Input
                    id="connection-label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Work, personal, support…"
                    autoComplete="off"
                  />
                  <p className="text-muted-foreground text-xs">
                    A label keeps several {serviceName} accounts easy to tell apart.
                  </p>
                </div>

                {whoAsks && (
                  <p data-testid="connect-sign-in-line" className="text-sm">
                    {whoAsks}
                  </p>
                )}
                {route ? (
                  <div
                    data-testid="connect-disclosure"
                    className="bg-muted/40 space-y-2 rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="text-muted-foreground size-4" aria-hidden />
                        <p className="text-sm font-medium">{route.displayName}</p>
                      </div>
                      {availableRouteCount > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowProviders((value) => !value)}
                        >
                          Change setup
                        </Button>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {route.disclosure}
                    </p>
                    {guidance && (
                      <p className="text-muted-foreground text-xs leading-relaxed">{guidance}</p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {route.payer === 'dorkos_managed'
                        ? 'DorkOS covers service usage.'
                        : 'Service usage is billed to you.'}
                    </p>
                  </div>
                ) : null}

                {showProviders && (
                  <fieldset className="space-y-2">
                    <legend className="text-xs font-medium">Available setups</legend>
                    {routes.map((candidate) => {
                      const available =
                        candidate.capabilities.authentication.status === 'available';
                      return (
                        <button
                          key={candidate.providerInstanceId}
                          type="button"
                          disabled={!available}
                          onClick={() => {
                            setRouteOverride(candidate.providerInstanceId);
                            setShowProviders(false);
                          }}
                          className="bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                        >
                          <span>
                            <span className="block text-sm font-medium">
                              {candidate.displayName}
                            </span>
                            <span className="text-muted-foreground block text-xs">
                              {candidate.mode === 'managed'
                                ? 'Managed by DorkOS'
                                : 'Your own account'}
                            </span>
                          </span>
                          {!available && (
                            <span className="text-muted-foreground text-xs">Unavailable</span>
                          )}
                        </button>
                      );
                    })}
                  </fieldset>
                )}

                {start.isError && (
                  <QueryErrorState
                    title="Couldn’t start the connection"
                    description="No account was connected. Try again when the service is ready."
                    onRetry={begin}
                    isRetrying={start.isPending}
                  />
                )}
              </>
            ) : activeFlow.state === 'starting' || activeFlow.state === 'pending' ? (
              <div className="space-y-4">
                {route && (
                  <div
                    data-testid="connect-disclosure"
                    className="bg-muted/40 space-y-1.5 rounded-lg p-3"
                  >
                    <p className="text-sm font-medium">{route.displayName}</p>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {route.disclosure}
                    </p>
                    {guidance && (
                      <p className="text-muted-foreground text-xs leading-relaxed">{guidance}</p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {route.payer === 'dorkos_managed'
                        ? 'DorkOS covers service usage.'
                        : 'Service usage is billed to you.'}
                    </p>
                  </div>
                )}
                {activeFlow.state === 'pending' && activeFlow.authorizeUrl ? (
                  <>
                    <p className="text-sm">
                      {whoAsks ?? `Continue with ${route?.displayName ?? 'the selected service'}.`}
                    </p>
                    {/* The authorize URL is the connector flow's answer, so it
                        clears the app's scheme allowlist before the browser is
                        handed anything (DOR-924). */}
                    <Button asChild className="w-full">
                      <ExternalLinkAnchor href={activeFlow.authorizeUrl}>
                        {authenticationAction(route, 'authorize')}
                        <ExternalLink className="size-4" aria-hidden />
                      </ExternalLinkAnchor>
                    </Button>
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-sm">
                    <RefreshCw className="size-4 animate-spin" aria-hidden />
                    {activeFlow.state === 'starting'
                      ? 'Starting the connection…'
                      : 'Waiting for sign-in…'}
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  This step is saved in the page address. You can return or reload without starting
                  over.
                </p>
                {flow.isError && (
                  <QueryErrorState
                    title="Couldn’t check the connection"
                    description="Sign-in may still finish. Check its current state again."
                    onRetry={() => void flow.refetch()}
                    isRetrying={flow.isFetching}
                  />
                )}
              </div>
            ) : activeFlow.state === 'connected' && !agentRequestId ? (
              <div className="space-y-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="text-success size-4" aria-hidden />
                  <span>{serviceName} is connected</span>
                </p>
                <ConnectionAccessCard
                  mode="page"
                  connectionId={activeFlow.connectionId}
                  serviceName={serviceName}
                  onSkip={finish}
                  onFinished={finish}
                  onEditExactActions={(connectionId) => {
                    onChooseAccess(connectionId);
                    finish();
                  }}
                />
              </div>
            ) : activeFlow.state === 'connected' ? (
              <div className="space-y-4">
                <div className="bg-success/5 flex items-start gap-3 rounded-lg p-4">
                  <CheckCircle2 className="text-success mt-0.5 size-5" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">{serviceName} is connected</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Return to the request to choose its exact actions.
                    </p>
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={() => {
                    onChooseAccess(activeFlow.connectionId);
                    finish();
                  }}
                >
                  Review requested access
                  <ArrowUpRight className="size-4" aria-hidden />
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p role="alert" className="text-destructive text-sm font-medium">
                  {activeFlow.state === 'expired'
                    ? 'This connection request expired.'
                    : 'The connection was not completed.'}
                </p>
                {'reason' in activeFlow && (
                  <p className="text-muted-foreground text-xs">{activeFlow.reason}</p>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    onFlowIdChange(null);
                    start.reset();
                    if (agentRequestId) close();
                  }}
                >
                  {agentRequestId ? 'Return to request' : 'Start again'}
                </Button>
              </div>
            )}
          </ResponsiveDialogBody>
          {!activeFlow && (
            <ResponsiveDialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              {!firstConnect && (
                <Button onClick={begin} disabled={!route || start.isPending}>
                  {start.isPending ? 'Starting…' : authenticationAction(route, 'start')}
                </Button>
              )}
            </ResponsiveDialogFooter>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
