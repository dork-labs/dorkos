import { useQuery } from '@tanstack/react-query';
import { cloudStatusKey } from '@/layers/features/cloud-link';
import { useConnectorCatalog } from '@/layers/entities/connectors';
import { useSettingsDeepLink, useTransport } from '@/layers/shared/model';
import { Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';

/** Make hosted account setup reachable while preserving the existing owner link flow. */
export function HostedAccountSetup() {
  const transport = useTransport();
  const settings = useSettingsDeepLink();
  const status = useQuery({
    queryKey: cloudStatusKey,
    queryFn: () => transport.getCloudStatus(),
    staleTime: 30_000,
  });
  const catalog = useConnectorCatalog('', status.data?.linked === true);

  if (status.isPending)
    return <Skeleton className="h-24 rounded-lg" aria-label="Checking DorkOS account" />;
  if (status.isError || !status.data) {
    return (
      <QueryErrorState
        title="Couldn’t check your DorkOS account"
        description="Try again to check account setup. Your own service accounts are still available below."
        onRetry={() => void status.refetch()}
        isRetrying={status.isFetching}
      />
    );
  }
  if (!status.data.linked) {
    return (
      <div className="bg-muted/40 space-y-3 rounded-lg p-4" data-testid="hosted-account-setup">
        <div className="space-y-1">
          <p className="text-sm font-medium">Connect Gmail, Linear, and more</p>
          <p className="text-muted-foreground text-sm">
            Link your DorkOS account to browse services. You’ll choose which accounts and agents get
            access.
          </p>
        </div>
        <Button
          data-testid="link-dorkos-account"
          onClick={() => settings.open('access', 'account')}
        >
          Link DorkOS account
        </Button>
        <p className="text-muted-foreground text-xs">
          Prefer your own service setup? Open Advanced account setup.
        </p>
      </div>
    );
  }
  if (catalog.isError || catalog.data?.pages.some((page) => page.warnings.length > 0)) {
    return (
      <QueryErrorState
        title="Some services couldn’t load"
        description="Try again, or use your own account in Advanced account setup."
        onRetry={() => void catalog.refetch()}
        isRetrying={catalog.isFetching}
      />
    );
  }
  return null;
}
