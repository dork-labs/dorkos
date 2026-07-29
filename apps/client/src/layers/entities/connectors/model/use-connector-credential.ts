import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** Arguments for the save-credential mutation. */
export interface SaveConnectorCredentialArgs {
  /** Provider type, e.g. `'composio' | 'nango'`. */
  provider: string;
  /** The vendor key. Travels once, into the server's encrypted store. */
  secret: string;
}

/**
 * Store a provider's vendor key — the server registers the provider live, no
 * restart. Invalidates the provider list plus the toolkit and account
 * aggregates, since a newly registered provider changes all three.
 */
export function useSaveConnectorCredential() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<ConnectorProviderStatus, Error, SaveConnectorCredentialArgs>({
    mutationFn: ({ provider, secret }) => transport.putConnectorCredential(provider, secret),
    onSuccess: () => invalidateProviderScope(queryClient),
  });
}

/**
 * Delete a provider's stored key — the server unregisters the provider live.
 * Idempotent server-side; same invalidation sweep as saving.
 */
export function useDeleteConnectorCredential() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<ConnectorProviderStatus, Error, { provider: string }>({
    mutationFn: ({ provider }) => transport.deleteConnectorCredential(provider),
    onSuccess: () => invalidateProviderScope(queryClient),
  });
}

/** A provider (un)registered: providers, toolkits, and accounts all changed. */
function invalidateProviderScope(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: connectorKeys.providers() });
  void queryClient.invalidateQueries({ queryKey: connectorKeys.toolkits() });
  void queryClient.invalidateQueries({ queryKey: connectorKeys.accounts() });
}
