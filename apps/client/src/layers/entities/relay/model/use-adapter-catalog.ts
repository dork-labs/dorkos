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

/**
 * Opt out of the app-wide mutation error toast in `query-client.ts`.
 *
 * Every mutation here reports its own failure through `onError`, showing the
 * server's sentence rather than a generic one. A refused save says exactly what
 * to change and what it did not touch — "Invalid channelOverrides: expected
 * JSON, and the existing value was left unchanged." Without this opt-out the
 * app-wide handler appends "Action failed. Please try again." underneath, which
 * talks over the reason and invites a retry of the same broken input.
 */
const OWN_ERROR_TOAST = { suppressErrorToast: true };

/** Mutation to add a new adapter instance. */
export function useAddAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      type,
      id,
      config,
    }: {
      type: string;
      id: string;
      config: Record<string, unknown>;
    }) => transport.addRelayAdapter(type, id, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      // Toast removed — wizard provides adapter-specific success message
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
    meta: OWN_ERROR_TOAST,
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
      // Deliberately not "Connection removed" — that toast reports deleting
      // one binding (IntegrationsTab.tsx). This one deletes the whole
      // Telegram/Slack/webhook source and every binding routed through it,
      // so it needs its own words (DOR-1754).
      toast.success('Removed — nothing routes through it anymore.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
    meta: OWN_ERROR_TOAST,
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
    meta: OWN_ERROR_TOAST,
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
