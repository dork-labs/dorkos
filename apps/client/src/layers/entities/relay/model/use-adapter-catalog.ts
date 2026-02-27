import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';

const CATALOG_KEY = ['relay', 'adapters', 'catalog'] as const;
const ADAPTERS_KEY = ['relay', 'adapters'] as const;

/** Extract a user-friendly message from an unknown error value. */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}

/**
 * Fetch the adapter catalog with available types and configured instances.
 *
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useAdapterCatalog(enabled = true) {
  const transport = useTransport();
  return useQuery<CatalogEntry[]>({
    queryKey: [...CATALOG_KEY],
    queryFn: () => transport.getAdapterCatalog(),
    enabled,
    refetchInterval: 30_000,
  });
}

/** Mutation to add a new adapter instance. */
export function useAddAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, config }: { type: string; id: string; config: Record<string, unknown> }) =>
      transport.addRelayAdapter(type, id, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      toast.success('Adapter added');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Mutation to remove an adapter instance by ID. */
export function useRemoveAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.removeRelayAdapter(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      toast.success('Adapter removed');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Mutation to update an existing adapter's configuration. */
export function useUpdateAdapterConfig() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, config }: { id: string; config: Record<string, unknown> }) =>
      transport.updateRelayAdapterConfig(id, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      toast.success('Configuration updated');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Mutation to test an adapter connection without persisting. */
export function useTestAdapterConnection() {
  const transport = useTransport();
  return useMutation({
    mutationFn: ({ type, config }: { type: string; config: Record<string, unknown> }) =>
      transport.testRelayAdapterConnection(type, config),
  });
}
