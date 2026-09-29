import { useState } from 'react';
import { ChevronDown, KeyRound } from 'lucide-react';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { useConnectorAppConnections, useConnectorProviders } from '@/layers/entities/connectors';
import { useSettingsDeepLink } from '@/layers/shared/model';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  QueryErrorState,
  Skeleton,
} from '@/layers/shared/ui';
import { KeyEntry } from './KeyEntry';

interface FirstConnectStepProps {
  /** Why the step shows although something is set up; `null` when nothing is. */
  reason: string | null;
  /**
   * Called before Settings opens from the step, so a dialog hosting the step
   * closes first rather than stacking under Settings.
   */
  onLeave?: () => void;
}

/**
 * The one-time step before a first app sign-in: pick how DorkOS reaches your
 * apps (connections-one-list design §6). It shows only while no way that is
 * set up reaches the app, so once a key works the dialog moves straight on to
 * sign-in — the saved key refreshes the catalog and this step unmounts.
 *
 * The big button is the person's own Composio key: DorkOS account app
 * connections are not available yet (DOR-1798), and when a linked DorkOS
 * account can serve apps it is used without asking, so this step never shows
 * for it. When a DorkOS account that apps were connected through isn't linked
 * anymore, linking it again is offered beside the key as an equal choice.
 * Nango is folded under "Other ways".
 */
export function FirstConnectStep({ reason, onLeave }: FirstConnectStepProps) {
  const providers = useConnectorProviders();
  const appConnections = useConnectorAppConnections();
  const settings = useSettingsDeepLink();
  const [showComposio, setShowComposio] = useState(false);

  if (providers.isPending) {
    return <Skeleton className="h-24 rounded-lg" aria-label="Loading setup options" />;
  }
  if (providers.isError) {
    return (
      <QueryErrorState
        title="Couldn’t load the setup options"
        description="Try again. Nothing was changed."
        onRetry={() => void providers.refetch()}
        isRetrying={providers.isFetching}
      />
    );
  }
  const composio = findStatus(providers.data, 'composio');
  const nango = findStatus(providers.data, 'nango');
  // An account that isn't linked anymore can be linked again; that and a key
  // are equal choices, so neither is pressed on the person.
  const newApps = appConnections.data?.newApps;
  const relink = newApps?.status === 'setup_needed' && newApps.reason === 'dorkos_account_unlinked';

  return (
    <div data-testid="first-connect-step" className="space-y-4">
      {reason && (
        <p role="status" className="bg-muted/40 rounded-lg p-3 text-sm">
          {reason}
        </p>
      )}

      {relink && (
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={() => {
            onLeave?.();
            settings.open('access', 'account');
          }}
        >
          Link my DorkOS account again
        </Button>
      )}

      {composio &&
        (showComposio ? (
          <KeyEntry status={composio} />
        ) : (
          <div className="space-y-1.5">
            <Button
              size="lg"
              variant={relink ? 'outline' : 'default'}
              className="w-full"
              onClick={() => setShowComposio(true)}
            >
              <KeyRound className="size-4" aria-hidden />
              Use my Composio key
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              If you have a Composio account, paste its key.
            </p>
          </div>
        ))}

      {nango && (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring group flex items-center gap-1 rounded-md text-sm font-medium">
            Other ways
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-3">
            <p className="text-muted-foreground text-xs">
              My own Nango server: you run Nango yourself, and sign-ins stay in your database.
            </p>
            <KeyEntry status={nango} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function findStatus(
  statuses: readonly ConnectorProviderStatus[] | undefined,
  type: string
): ConnectorProviderStatus | undefined {
  return statuses?.find((status) => status.type === type);
}
