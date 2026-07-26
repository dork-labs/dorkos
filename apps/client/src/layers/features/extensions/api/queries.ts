import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { extensionApiUrl } from '../model/extension-api-url';

/** Response shape from enable/disable endpoints. */
interface ExtensionActionResponse {
  extension: ExtensionRecordPublic;
  reloadRequired: boolean;
}

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
      const res = await fetch(extensionApiUrl('/extensions'));
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

  return useMutation<ExtensionActionResponse, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(extensionApiUrl(`/extensions/${id}/enable`), { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to enable extension '${id}': ${res.status}`);
      return res.json() as Promise<ExtensionActionResponse>;
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

  return useMutation<ExtensionActionResponse, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(extensionApiUrl(`/extensions/${id}/disable`), { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to disable extension '${id}': ${res.status}`);
      return res.json() as Promise<ExtensionActionResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}

/** Response shape from the approve/revoke endpoints. */
interface ExtensionApprovalResponse {
  extension: ExtensionRecordPublic;
}

/**
 * Let an extension run its code inside DorkOS, or stop it from doing so
 * (DOR-516).
 *
 * The person does this once per extension. The server records it in
 * `~/.dork/config.json`, where an agent cannot write it, and starts or stops the
 * extension straight away so no restart is needed.
 *
 * The server refuses this call for anything that identifies itself as an agent,
 * and under Require login it needs a real session cookie. This hook is the
 * cockpit's path to it; hiding a button is a courtesy, the server bar is the
 * guarantee.
 *
 * @param approve - `true` to allow the extension to run, `false` to stop it.
 */
export function useSetExtensionRunApproval(approve: boolean) {
  const queryClient = useQueryClient();

  return useMutation<ExtensionApprovalResponse, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(
        extensionApiUrl(`/extensions/${id}/${approve ? 'approve' : 'revoke'}`),
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to update '${id}': ${res.status}`);
      }
      return res.json() as Promise<ExtensionApprovalResponse>;
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
      const res = await fetch(extensionApiUrl('/extensions/reload'), { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to reload extensions: ${res.status}`);
      return res.json() as Promise<ExtensionRecordPublic[]>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}
