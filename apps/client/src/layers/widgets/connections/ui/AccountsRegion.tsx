import { useRef } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Skeleton } from '@/layers/shared/ui';
import { useConnectorToolkits } from '@/layers/entities/connectors';
import {
  AccountsFirstRun,
  AccountsList,
  AgentAccounts,
  ProviderSetup,
  ServiceGrid,
} from '@/layers/features/connections';

/**
 * Services your agents can act on for you.
 *
 * The page's other half, with its own consent story: what an agent may do
 * under your name, elsewhere. The region never disappears — with nothing
 * connectable it names the services and the one-time setup in the way rather
 * than rendering an empty box.
 */
export function AccountsRegion() {
  const { data, isLoading } = useConnectorToolkits();
  const carrierRef = useRef<HTMLDivElement>(null);

  const hasConnectableServices = (data?.toolkits.length ?? 0) > 0;

  return (
    <section aria-labelledby="region-accounts" className="space-y-6">
      <header>
        <h2 id="region-accounts" className="text-base font-semibold">
          Accounts
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Services your agents can act on for you.
        </p>
      </header>

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : hasConnectableServices ? (
        <>
          <ServiceGrid />
          <section aria-labelledby="connections-connected" className="space-y-3">
            <h3 id="connections-connected" className="text-sm font-semibold">
              Connected
            </h3>
            <AccountsList />
          </section>
          <AgentAccounts />
        </>
      ) : (
        <AccountsFirstRun
          onSetUpCarrier={() =>
            carrierRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        />
      )}

      {/* Named for what they are. Every word tried above this one — "engine",
          "provider" — failed to mean anything to the people using it. */}
      <div ref={carrierRef}>
        <Collapsible defaultOpen={!isLoading && !hasConnectableServices}>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring rounded-md text-sm font-medium">
            Composio &amp; Nango
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
              These outside services hold the sign-ins that let your agents act for you. Add a key
              from one and the services it reaches appear above.
            </p>
            <ProviderSetup />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  );
}
