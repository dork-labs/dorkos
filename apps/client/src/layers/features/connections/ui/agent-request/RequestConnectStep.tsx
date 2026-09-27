import { useEffect, useId, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ConnectorAgentRequestItem } from '@dorkos/shared/connector-schemas';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAgentRequestAuthentication,
  useConnectorCatalog,
  useStartConnectorAgentRequestAuthentication,
} from '@/layers/entities/connectors';
import { Button, ExternalLinkAnchor, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import {
  accountRoutes,
  chooseConnectRoute,
  firstConnectReason,
  isCatalogOutage,
  needsFirstConnectStep,
  signInLine,
  wayName,
} from '../../lib/connect-route';
import { AccessCardFrame } from '../access/AccessCardFrame';
import { FirstConnectStep } from '../FirstConnectStep';

interface RequestConnectStepProps {
  /** The pending request whose app has no account yet. */
  request: ConnectorAgentRequestItem;
  /** The app's display name. */
  serviceName: string;
  /** The app as the catalog lists it, once read. */
  service: ConnectorCatalogService | null;
  /** The sign-in finished; the new account's id. */
  onConnected: (connectionId: string) => void;
  /** Answer "Not now". */
  onDecline: () => void;
  /** An answer is being saved. */
  deciding: boolean;
  /** Extra classes for the card's frame. */
  className?: string;
}

/**
 * The card's first question when no account of the app is connected yet:
 * "Connect Gmail". Connect goes through the app's own sign-in page, the only
 * moment the person leaves the chat, and says whose page that is before it
 * opens. When no way to reach apps is set up, the one-time setup step shows
 * inside the card first. Signing in is bound to this exact request, so the
 * server keeps one sign-in per request and a reload picks the same one back up.
 */
export function RequestConnectStep({
  request,
  serviceName,
  service,
  onConnected,
  onDecline,
  deciding,
  className,
}: RequestConnectStepProps) {
  const titleId = useId();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const start = useStartConnectorAgentRequestAuthentication(request.requestId);
  const flow = useConnectorAgentRequestAuthentication(request.requestId, flowId);
  const lookup = useConnectorCatalog(request.serviceSlug);
  const firstPage = lookup.data?.pages[0];
  const appConnections = firstPage?.appConnections;
  const routes = accountRoutes(service);
  const route = chooseConnectRoute(routes, appConnections?.newApps);
  const activeFlow = flow.data ?? start.data;
  const firstConnect = !activeFlow && needsFirstConnectStep(service);
  const whoAsks = signInLine(route, service);

  const connectedId = activeFlow?.state === 'connected' ? activeFlow.connectionId : null;
  useEffect(() => {
    if (connectedId) onConnected(connectedId);
  }, [connectedId, onConnected]);

  const begin = () => {
    if (firstConnect) {
      setSetupOpen(true);
      return;
    }
    if (!route) return;
    start.mutate(
      { providerInstanceId: route.providerInstanceId },
      { onSuccess: (result) => setFlowId(result.flowId) }
    );
  };

  const waiting = activeFlow?.state === 'starting' || activeFlow?.state === 'pending';

  let body: React.ReactNode;
  if (lookup.isPending && !service) {
    body = <Skeleton className="h-10 rounded-lg" aria-label={`Loading ${serviceName}`} />;
  } else if (firstConnect && setupOpen) {
    body =
      routes.length === 0 &&
      isCatalogOutage(firstPage) &&
      appConnections?.newApps.status === 'ready' ? (
        <QueryErrorState
          title={`Couldn’t reach ${serviceName} just now`}
          description={`${wayName(appConnections.newApps.way)} didn’t answer. Try again in a moment.`}
          onRetry={() => void lookup.refetch()}
          isRetrying={lookup.isFetching}
        />
      ) : (
        <FirstConnectStep reason={firstConnectReason(appConnections, service)} />
      );
  } else if (waiting) {
    body = (
      <div className="space-y-3">
        {whoAsks && <p className="text-sm">{whoAsks}</p>}
        {activeFlow.state === 'pending' && activeFlow.authorizeUrl ? (
          <Button asChild className="w-full sm:w-auto">
            {/* The address came from the sign-in flow, so it passes the app's
                link allowlist before the browser is handed anything. */}
            <ExternalLinkAnchor href={activeFlow.authorizeUrl}>
              Sign in to {serviceName}
              <ExternalLink className="size-4" aria-hidden />
            </ExternalLinkAnchor>
          </Button>
        ) : null}
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {activeFlow.state === 'starting'
            ? 'Getting the sign-in page ready…'
            : `Waiting for you to finish signing in to ${serviceName}…`}
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-sm">
          <span className="text-muted-foreground">{request.agent.displayName} asked: </span>
          {request.reason}
        </p>
        {whoAsks && <p className="text-muted-foreground text-xs">{whoAsks}</p>}
        {start.isError && (
          <p role="alert" className="text-destructive text-sm">
            Couldn’t start signing in. Nothing was connected. Try again.
          </p>
        )}
      </div>
    );
  }

  return (
    <AccessCardFrame
      titleId={titleId}
      toolkit={request.serviceSlug}
      title={`Connect ${serviceName}`}
      subtitle={`So ${request.agent.displayName} can use it`}
      className={className}
    >
      {body}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDecline} disabled={deciding}>
          Not now
        </Button>
        {!waiting && !(firstConnect && setupOpen) && (
          <Button
            onClick={begin}
            disabled={start.isPending || deciding || (!firstConnect && !route)}
          >
            {start.isPending ? 'Starting…' : `Connect ${serviceName}`}
          </Button>
        )}
      </div>
    </AccessCardFrame>
  );
}
