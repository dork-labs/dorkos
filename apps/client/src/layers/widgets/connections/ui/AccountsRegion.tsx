import { useState } from 'react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import {
  AccountsList,
  ConnectDialog,
  ConnectionAccessDialog,
  ConnectionDetailSheet,
  ManagementReviews,
  ProviderSetup,
  ServiceGrid,
} from '@/layers/features/connections';

interface AccountsRegionProps {
  /** URL-selected management request. */
  selectedReviewId?: string | null;
  /** URL-selected durable authentication flow. */
  selectedFlowId?: string | null;
  /** Put a request into the URL for reload and Back/Forward support. */
  onSelectReview?: (reviewRequestId: string) => void;
  /** Remove the selected request from the URL. */
  onCloseReview?: () => void;
  /** Put or clear an authentication flow in the URL. */
  onSelectFlow?: (flowId: string | null) => void;
}

/** Account services, stable connections, owner reviews, and advanced provider setup. */
export function AccountsRegion({
  selectedReviewId = null,
  selectedFlowId = null,
  onSelectReview = () => undefined,
  onCloseReview = () => undefined,
  onSelectFlow = () => undefined,
}: AccountsRegionProps = {}) {
  const [selectedService, setSelectedService] = useState<ConnectorCatalogService | null>(null);
  const [detailConnectionId, setDetailConnectionId] = useState<string | null>(null);
  const [accessConnectionId, setAccessConnectionId] = useState<string | null>(null);

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
        </div>
        <ServiceGrid onConnect={setSelectedService} />
      </header>

      <section aria-labelledby="connections-connected" className="space-y-3">
        <h3 id="connections-connected" className="text-sm font-semibold">
          Connected accounts
        </h3>
        <AccountsList onOpenDetail={setDetailConnectionId} />
      </section>

      {selectedFlowId && !selectedService && (
        <p className="text-muted-foreground text-xs">Your saved sign-in is ready to continue.</p>
      )}

      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring rounded-md text-sm font-medium">
          Advanced account setup
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-3">
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
            Use your own Composio or Nango account to manage its billing and setup yourself.
          </p>
          <ProviderSetup />
        </CollapsibleContent>
      </Collapsible>

      <ManagementReviews
        selectedReviewId={selectedReviewId}
        onSelectReview={onSelectReview}
        onCloseReview={onCloseReview}
      />

      <ConnectDialog
        key={selectedFlowId ?? selectedService?.serviceSlug ?? 'idle'}
        service={selectedService}
        flowId={selectedFlowId}
        onFlowIdChange={onSelectFlow}
        onClose={() => setSelectedService(null)}
        onChooseAccess={setAccessConnectionId}
      />
      <ConnectionDetailSheet
        connectionId={detailConnectionId}
        onClose={() => setDetailConnectionId(null)}
        onManageAccess={(connectionId) => {
          setDetailConnectionId(null);
          setAccessConnectionId(connectionId);
        }}
        onReconnect={(flowId) => {
          setDetailConnectionId(null);
          onSelectFlow(flowId);
        }}
      />
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
