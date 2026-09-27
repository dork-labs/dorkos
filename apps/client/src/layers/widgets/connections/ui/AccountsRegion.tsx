import { useRef, useState } from 'react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  AccountsList,
  AgentRequests,
  ConnectDialog,
  ConnectionAccessDialog,
  ConnectionDetailSheet,
  ManagementReviews,
  ServiceGrid,
} from '@/layers/features/connections';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useChatAppSetup } from './ChatAppSetup';

interface AccountsRegionProps {
  /** URL-selected management request. */
  selectedReviewId?: string | null;
  /** URL-selected durable authentication flow. */
  selectedFlowId?: string | null;
  /** URL-selected agent service request. */
  selectedRequestId?: string | null;
  /** Put a request into the URL for reload and Back/Forward support. */
  onSelectReview?: (reviewRequestId: string) => void;
  /** Remove the selected request from the URL. */
  onCloseReview?: () => void;
  /** Put or clear an authentication flow in the URL. */
  onSelectFlow?: (flowId: string | null) => void;
  /** Put an agent request into the URL. */
  onSelectRequest?: (requestId: string) => void;
  /** Remove the selected agent request from the URL. */
  onCloseRequest?: () => void;
}

/**
 * Account services, stable connections and owner reviews. How DorkOS reaches
 * these services (your own Composio or Nango key) is set in Settings ›
 * Connections, not here.
 */
export function AccountsRegion({
  selectedReviewId = null,
  selectedFlowId = null,
  selectedRequestId = null,
  onSelectReview = () => undefined,
  onCloseReview = () => undefined,
  onSelectFlow = () => undefined,
  onSelectRequest = () => undefined,
  onCloseRequest = () => undefined,
}: AccountsRegionProps = {}) {
  const [selectedService, setSelectedService] = useState<ConnectorCatalogService | null>(null);
  const [detailConnectionId, setDetailConnectionId] = useState<string | null>(null);
  const [accessConnectionId, setAccessConnectionId] = useState<string | null>(null);
  const [connectingForRequest, setConnectingForRequest] = useState(false);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const chatAppSetup = useChatAppSetup();

  return (
    <section aria-labelledby="region-accounts" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="region-accounts" className="text-base font-semibold">
            Accounts
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Services your agents can act on for you.
          </p>
          <OwnKeyPointer />
        </div>
        <ServiceGrid onConnect={setSelectedService} onConnectChat={chatAppSetup.open} />
      </header>

      <AccountsList
        onOpenDetail={(connectionId) => {
          detailOpenerRef.current = document.activeElement as HTMLElement | null;
          setDetailConnectionId(connectionId);
        }}
      />

      <AgentRequests
        selectedRequestId={selectedRequestId}
        suspended={
          selectedRequestId !== null && (selectedService !== null || selectedFlowId !== null)
        }
        onSelectRequest={onSelectRequest}
        onCloseRequest={onCloseRequest}
        onConnectService={(service) => {
          setConnectingForRequest(true);
          setSelectedService(service);
        }}
      />

      {selectedFlowId && !selectedService && (
        <p className="text-muted-foreground text-xs">Your saved sign-in is ready to continue.</p>
      )}

      <ManagementReviews
        selectedReviewId={selectedReviewId}
        onSelectReview={onSelectReview}
        onCloseReview={onCloseReview}
      />

      <ConnectDialog
        key={selectedFlowId ?? selectedService?.serviceSlug ?? 'idle'}
        service={selectedService}
        flowId={selectedFlowId}
        agentRequestId={
          selectedRequestId && (connectingForRequest || selectedFlowId) ? selectedRequestId : null
        }
        onFlowIdChange={onSelectFlow}
        onClose={() => {
          setSelectedService(null);
          if (!selectedFlowId) setConnectingForRequest(false);
        }}
        onChooseAccess={(connectionId) => {
          if (connectingForRequest) {
            setConnectingForRequest(false);
            setSelectedService(null);
            return;
          }
          setAccessConnectionId(connectionId);
        }}
      />
      <ConnectionDetailSheet
        connectionId={detailConnectionId}
        onClose={() => {
          setDetailConnectionId(null);
          requestAnimationFrame(() => detailOpenerRef.current?.focus());
        }}
        onManageAccess={(connectionId) => {
          setDetailConnectionId(null);
          setAccessConnectionId(connectionId);
        }}
        onReconnect={(flowId) => {
          setDetailConnectionId(null);
          onSelectFlow(flowId);
        }}
      />
      {chatAppSetup.dialog}
      <ConnectionAccessDialog
        key={accessConnectionId ?? 'closed'}
        connectionId={accessConnectionId}
        open={accessConnectionId !== null}
        onOpenChange={(open) => {
          if (!open) setAccessConnectionId(null);
        }}
      />
    </section>
  );
}

/**
 * The page's one pointer to Settings › Connections, where your own Composio or
 * Nango key lives. It sits under the region's heading in every state (linked
 * or not, with or without apps), so the way to use your own key is never
 * hidden behind a failure or a first connect. Static on purpose: it reads
 * nothing, so it can't fail and it never waits on a server call.
 */
function OwnKeyPointer() {
  const settings = useSettingsDeepLink();
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      Prefer your own Composio or Nango account?{' '}
      <Button
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => settings.open('connections', 'ways')}
      >
        Set it up in Settings › Connections
      </Button>
    </p>
  );
}
