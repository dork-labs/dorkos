import { useMemo, useState } from 'react';
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
  /** Opens exact agent access for the newly connected stable account. */
  onChooseAccess: (connectionId: string) => void;
}

function defaultRoute(
  routes: ConnectorCatalogProviderRoute[]
): ConnectorCatalogProviderRoute | null {
  const available = routes.filter(
    (route) => route.capabilities.authentication.status === 'available'
  );
  return (
    available.find((route) => route.mode === 'managed') ??
    available.find((route) => route.mode === 'byo') ??
    null
  );
}

function accountRoutes(service: ConnectorCatalogService | null): ConnectorCatalogProviderRoute[] {
  return service?.intents.find((intent) => intent.kind === 'account')?.routes ?? [];
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
  const lookup = useConnectorCatalog(flow.data?.toolkit ?? service?.serviceSlug ?? '');
  const lookedUpService = lookup.data?.pages
    .flatMap((page) => page.services)
    .find((candidate) => candidate.serviceSlug === flow.data?.toolkit);
  const resolvedService = service ?? lookedUpService ?? null;
  const routes = accountRoutes(resolvedService);
  const availableRouteCount = routes.filter(
    (candidate) => candidate.capabilities.authentication.status === 'available'
  ).length;
  const route =
    routes.find((candidate) => candidate.providerInstanceId === routeOverride) ??
    (flow.data
      ? routes.find((candidate) => candidate.providerInstanceId === flow.data.providerInstanceId)
      : null) ??
    defaultRoute(routes);
  const activeFlow: ConnectorAuthenticationFlowState | undefined = flow.data ?? start.data;

  const serviceName = resolvedService?.displayName ?? titleCase(activeFlow?.toolkit ?? 'service');
  const unavailableReason = useMemo(() => {
    if (route) return null;
    const unavailable = routes.find(
      (candidate) => candidate.capabilities.authentication.status === 'unsupported'
    )?.capabilities.authentication;
    return unavailable?.status === 'unsupported'
      ? unavailable.reason
      : 'No configured setup can connect this service yet.';
  }, [route, routes]);

  const close = () => {
    setOpen(false);
    onClose();
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
          className="max-h-[90vh] sm:max-w-lg [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100"
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Connect {serviceName}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {activeFlow
                ? 'Finish this connection, then choose which agents may use it.'
                : 'Name the account and review who handles its sign-in.'}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-4 pb-4">
            {!activeFlow ? (
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
                    {authenticationGuidance(route, serviceName) && (
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {authenticationGuidance(route, serviceName)}
                      </p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {route.payer === 'dorkos_managed'
                        ? 'DorkOS covers service usage.'
                        : 'Service usage is billed to you.'}
                    </p>
                  </div>
                ) : (
                  <p
                    role="alert"
                    className="text-destructive bg-destructive/5 rounded-lg p-3 text-sm"
                  >
                    {unavailableReason}
                  </p>
                )}

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
                    {authenticationGuidance(route, serviceName) && (
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {authenticationGuidance(route, serviceName)}
                      </p>
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
                      Continue with {route?.displayName ?? 'the selected service'}.
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
            ) : activeFlow.state === 'connected' ? (
              <div className="space-y-4">
                <div className="bg-success/5 flex items-start gap-3 rounded-lg p-4">
                  <CheckCircle2 className="text-success mt-0.5 size-5" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">{serviceName} is connected</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {agentRequestId
                        ? 'Return to the request to choose its exact actions.'
                        : 'No agent can use it until you choose access.'}
                    </p>
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={() => {
                    onChooseAccess(activeFlow.connectionId);
                    onFlowIdChange(null);
                    close();
                  }}
                >
                  {agentRequestId ? 'Review requested access' : 'Choose agents'}
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
              <Button onClick={begin} disabled={!route || start.isPending}>
                {start.isPending ? 'Starting…' : authenticationAction(route, 'start')}
              </Button>
            </ResponsiveDialogFooter>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
