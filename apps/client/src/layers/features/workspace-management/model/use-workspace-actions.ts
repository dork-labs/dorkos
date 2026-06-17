import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { useInvalidateWorkspaces } from '@/layers/entities/workspace';
import type { RemoveResult, Workspace } from '@dorkos/shared/workspace';

/** Pin or unpin a workspace, refreshing the list on success. */
export function usePinWorkspace() {
  const transport = useTransport();
  const invalidate = useInvalidateWorkspaces();
  return useMutation<Workspace, Error, { id: string; pinned: boolean }>({
    mutationFn: ({ id, pinned }) => transport.pinWorkspace(id, pinned),
    onSuccess: () => invalidate(),
  });
}

/**
 * Remove a workspace. Without `force` the server refuses a dirty workspace
 * (`RemoveResult.blocked === 'dirty'`); the caller then re-invokes with
 * `force: true` after an explicit confirmation.
 */
export function useRemoveWorkspace() {
  const transport = useTransport();
  const invalidate = useInvalidateWorkspaces();
  return useMutation<RemoveResult, Error, { id: string; force?: boolean }>({
    mutationFn: ({ id, force }) => transport.removeWorkspace(id, force),
    onSuccess: (result) => {
      if (result.removed) return invalidate();
    },
  });
}
