import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  STALE_APPROVAL_CODE,
  type ApproveExtensionRequest,
} from '@dorkos/shared/extension-approval-schemas';
import { extensionQueryKeys, useExtensionList } from '@/layers/entities/extension';
import { extensionApiUrl } from '../model/extension-api-url';

/** Response shape from enable/disable endpoints. */
interface ExtensionActionResponse {
  extension: ExtensionRecordPublic;
  reloadRequired: boolean;
}

/**
 * TanStack Query key factory for extension queries. The list key is the
 * extension entity's own, so the inbox and this tab share one cache entry.
 *
 * @module features/extensions/api
 */
export const extensionKeys = {
  all: extensionQueryKeys.all,
  lists: extensionQueryKeys.list,
  detail: (id: string) => [...extensionKeys.all, 'detail', id] as const,
};

/**
 * Fetch all discovered extensions with their current status. The read lives in
 * the extension entity (`useExtensionList`), shared with the Activity inbox.
 */
export function useExtensions() {
  return useExtensionList();
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
      if (!res.ok) {
        // Read the server's sentence before falling back to a status code. The
        // person bar on this route (DOR-1507) answers 403 with a message that
        // says what DorkOS did not do and who can do it; a bare number would
        // throw that away and leave "403" on screen.
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(
          body.message ?? body.error ?? `Couldn’t turn on ${id}. The server answered ${res.status}.`
        );
      }
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
      if (!res.ok) {
        // Read the server's sentence before falling back to a status code. The
        // person bar on this route (DOR-1507) answers 403 with a message that
        // says what DorkOS did not do and who can do it; a bare number would
        // throw that away and leave "403" on screen.
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(
          body.message ??
            body.error ??
            `Couldn’t turn off ${id}. The server answered ${res.status}.`
        );
      }
      return res.json() as Promise<ExtensionActionResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}

/** The copy a Settings card shows: its id, version and carrying plugin. */
export interface RunApprovalTarget {
  id: string;
  version: string;
  plugin: string | null;
  /**
   * The permission set the card lists (DOR-2686), echoed so a widening since
   * the card was drawn is refused as stale. Absent when it listed none.
   */
  permissions?: ApproveExtensionRequest['permissions'];
}

/**
 * A refused approve or revoke: the server's sentence, and whether the card
 * went out of date while it was on screen (`stale_approval`).
 */
export class RunApprovalError extends Error {
  constructor(
    message: string,
    /** True when the extension changed since the card was drawn. */
    readonly stale: boolean
  ) {
    super(message);
  }
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

  return useMutation<ExtensionApprovalResponse, Error, RunApprovalTarget>({
    mutationFn: async ({ id, version, plugin, permissions }: RunApprovalTarget) => {
      // Approving binds the copy the card shows — its version and carrying
      // plugin — so a copy that took its place since the card was drawn is
      // refused with `stale_approval` instead of approved (DOR-2517). The card
      // is never told a path; the server compares what it is sent.
      const res = await fetch(
        extensionApiUrl(`/extensions/${id}/${approve ? 'approve' : 'revoke'}`),
        approve
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version, plugin, ...(permissions ? { permissions } : {}) }),
            }
          : { method: 'POST' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new RunApprovalError(
          body.error ?? `Couldn’t update ${id}. The server answered ${res.status}.`,
          body.code === STALE_APPROVAL_CODE
        );
      }
      return res.json() as Promise<ExtensionApprovalResponse>;
    },
    // Refreshed after a refusal too: a stale card redraws with what the
    // extension asks for now, so the next yes is given to that.
    onSettled: () => {
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
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      return res.json() as Promise<ExtensionRecordPublic[]>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    },
  });
}
