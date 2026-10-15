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
 * set up reaches the app, so once a way works the dialog moves straight on to
 * sign-in — a saved key refreshes the catalog and this step unmounts.
 *
 * Two choices, always both on screen (FB-57: a person with no DorkOS account
 * saw only the key, and was stuck). The DorkOS account comes first when
 * nothing is set up, as on the first-run screen: sign in or create one, and
 * DorkOS connects the apps. When an account is linked but not working, or no
 * longer linked, linking it again sits beside the key as an equal choice. When
 * a saved key is the problem, the key comes first. Nango is folded under
 * "Other ways".
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
  const newApps = appConnections.data?.newApps;
  const setupReason = newApps?.status === 'setup_needed' ? newApps.reason : null;
  // An account that is linked but not working, or no longer linked, can be
  // linked again; that and a key are equal choices, so neither is pressed.
  const relink =
    setupReason === 'dorkos_account_unlinked' || setupReason === 'dorkos_account_unavailable';
  // With no account at all, the account is the way most people want.
  const accountFirst = setupReason === 'nothing_set_up';
  // A saved key that failed comes first: fixing it is the shortest way back.
  const keyFirst = setupReason === 'own_key_unavailable';
  const offerAccount = relink || accountFirst || keyFirst;
  const openAccount = () => {
    onLeave?.();
    settings.open('account');
  };
  const accountChoice = relink ? (
    <Button size="lg" variant="outline" className="w-full" onClick={openAccount}>
      Link my DorkOS account again
    </Button>
  ) : (
    <div className="space-y-1.5">
      <Button
        size="lg"
        variant={accountFirst ? 'default' : 'outline'}
        className="w-full"
        onClick={openAccount}
      >
        Use a DorkOS account
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        Sign in or create one. DorkOS connects your apps for you.
      </p>
    </div>
  );

  return (
    <div data-testid="first-connect-step" className="space-y-4">
      {reason && (
        <p role="status" className="bg-muted/40 rounded-lg p-3 text-sm">
          {reason}
        </p>
      )}

      {offerAccount && !keyFirst && accountChoice}

      {composio &&
        (showComposio ? (
          <KeyEntry status={composio} />
        ) : (
          <div className="space-y-1.5">
            <Button
              size="lg"
              variant={relink || accountFirst ? 'outline' : 'default'}
              className="w-full"
              onClick={() => setShowComposio(true)}
            >
              <KeyRound className="size-4" aria-hidden />
              Use my Composio key
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              Have a Composio account? Paste its key.
            </p>
          </div>
        ))}

      {offerAccount && keyFirst && accountChoice}

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
              Your own Nango server. Sign-ins stay in your database.
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
