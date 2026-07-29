import { Skeleton } from '@/layers/shared/ui';
import { useConnectorProviders } from '@/layers/entities/connectors';
import { ProviderSetupCard } from './ProviderSetupCard';

/**
 * The provider setup section: one card per credential-gated backend, from
 * `GET /api/connectors/providers`. This is the single vendor-forward corner of
 * the Connections surface — everywhere else leads with services.
 */
export function ProviderSetup() {
  const { data: providers, isLoading, isError, error } = useConnectorProviders();

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-36 rounded-lg" />
        <Skeleton className="h-36 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        Could not load provider setup: {error.message}
      </p>
    );
  }

  if (!providers || providers.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This server has no connector providers to set up.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {providers.map((status) => (
        <ProviderSetupCard key={status.type} status={status} />
      ))}
    </div>
  );
}
