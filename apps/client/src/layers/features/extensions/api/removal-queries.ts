/**
 * Removing an extension and forgetting an approval whose extension is gone
 * (DOR-3541, DOR-3372). Both are person-only on the server; these hooks are
 * the app's path to them.
 *
 * @module features/extensions/api/removal-queries
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { extensionQueryKeys } from '@/layers/entities/extension';
import { extensionApiUrl } from '../model/extension-api-url';

/** An approval left behind by an extension that is no longer installed. */
export interface StaleApproval {
  /** The extension id the approval names. */
  id: string;
  /** The folder it was given to, when the server recorded one. */
  path: string | null;
  /** The plugin that carried it, when it came inside one. */
  plugin: string | null;
}

/** The query key for the approvals left behind. Under `['extensions']`, so one refresh covers it. */
export const staleApprovalsKey = [...extensionQueryKeys.all, 'stale-approvals'] as const;

/** Read the server's answer, or throw its sentence. */
async function answer<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${fallback} The server answered ${res.status}.`);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

/** Approvals whose extension is installed nowhere, A–Z. */
export function useStaleApprovals() {
  return useQuery({
    queryKey: staleApprovalsKey,
    queryFn: async ({ signal }) => {
      const res = await fetch(extensionApiUrl('/extensions/stale-approvals'), { signal });
      const body = await answer<{ approvals: StaleApproval[] }>(
        res,
        'Couldn’t check for approvals left behind.'
      );
      return body.approvals;
    },
  });
}

/** Refresh the extension list and the approvals left behind. */
function useRefreshExtensions() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
}

/** Remove an installed extension: its folder and everything it was allowed. */
export function useRemoveExtension() {
  const refresh = useRefreshExtensions();
  return useMutation<{ removed: string }, Error, string>({
    mutationFn: async (id) =>
      answer(
        await fetch(extensionApiUrl(`/extensions/${id}/remove`), { method: 'POST' }),
        `Couldn’t remove ${id}.`
      ),
    onSettled: refresh,
  });
}

/** Forget the approval of an extension whose folder is gone. */
export function useForgetApproval() {
  const refresh = useRefreshExtensions();
  return useMutation<void, Error, string>({
    mutationFn: async (id) =>
      answer(
        await fetch(extensionApiUrl(`/extensions/${id}/forget`), { method: 'POST' }),
        `Couldn’t forget ${id}.`
      ),
    onSettled: refresh,
  });
}
