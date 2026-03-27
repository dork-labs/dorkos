import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

/**
 * TanStack Query key factory for extension queries.
 *
 * @module features/extensions/api
 */
export const extensionKeys = {
  all: ['extensions'] as const,
  lists: () => [...extensionKeys.all, 'list'] as const,
  detail: (id: string) => [...extensionKeys.all, 'detail', id] as const,
};

/**
 * Fetch all discovered extensions with their current status.
 *
 * Polls every 30 seconds so newly compiled extensions appear without a page
 * refresh. Background polling is disabled to avoid unnecessary requests when
 * the tab is hidden.
 */
export function useExtensions() {
  return useQuery<ExtensionRecordPublic[]>({
    queryKey: extensionKeys.lists(),
    queryFn: async () => {
      const res = await fetch('/api/extensions');
      if (!res.ok) throw new Error(`Failed to fetch extensions: ${res.status}`);
      return res.json() as Promise<ExtensionRecordPublic[]>;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Enable an extension by ID.
 *
 * Invalidates the extension list on success so the UI reflects the updated
 * status immediately.
 */
export function useEnableExtension() {
  const queryClient = useQueryClient();

  return useMutation<ExtensionRecordPublic, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/extensions/${id}/enable`, { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to enable extension '${id}': ${res.status}`);
      return res.json() as Promise<ExtensionRecordPublic>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}

/**
 * Disable an extension by ID.
 *
 * Invalidates the extension list on success so the UI reflects the updated
 * status immediately.
 */
export function useDisableExtension() {
  const queryClient = useQueryClient();

  return useMutation<ExtensionRecordPublic, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/extensions/${id}/disable`, { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to disable extension '${id}': ${res.status}`);
      return res.json() as Promise<ExtensionRecordPublic>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}

/**
 * Trigger a filesystem re-scan and recompile of all extensions.
 *
 * Invalidates the extension list so callers see fresh status after reload.
 */
export function useReloadExtensions() {
  const queryClient = useQueryClient();

  return useMutation<ExtensionRecordPublic[], Error, void>({
    mutationFn: async () => {
      const res = await fetch('/api/extensions/reload', { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to reload extensions: ${res.status}`);
      return res.json() as Promise<ExtensionRecordPublic[]>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}
