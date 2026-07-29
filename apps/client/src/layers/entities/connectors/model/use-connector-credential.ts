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
    meta: { errorLabel: "Couldn't save the provider key" },
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
    meta: { errorLabel: "Couldn't remove the provider key" },
    onSuccess: () => invalidateProviderScope(queryClient),
  });
}

/**
 * A provider (un)registered: every connector read — providers, toolkits,
 * accounts, cached recommendations, session surfaces — may now answer
 * differently, so the whole domain prefix is swept (a cached recommendation
 * naming a just-deleted provider would 404 the next Connect).
 */
function invalidateProviderScope(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: connectorKeys.all });
}
