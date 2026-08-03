import { useRef } from 'react';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
} from '@/layers/shared/ui';
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
  const { data, isLoading, isError, refetch } = useConnectorToolkits();
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
      ) : isError ? (
        // A failed fetch is not a settled empty state. Saying "nothing can be
        // connected yet" here would present a transient network problem as the
        // truth about the account, and hide the carriers below that a person
        // could still set up. Say what actually happened, and offer a retry.
        <div className="bg-card shadow-soft space-y-3 rounded-lg border p-5">
          <p className="text-sm font-medium">Couldn&rsquo;t load your services</p>
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
            Something went wrong reaching them just now. This is usually temporary.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
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
        <Collapsible defaultOpen={!isLoading && !isError && !hasConnectableServices}>
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
