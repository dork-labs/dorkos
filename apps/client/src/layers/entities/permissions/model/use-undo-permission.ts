import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PermissionUndoSkip } from '@dorkos/shared/permissions';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { permissionKeys } from './permission-keys';

/** One Undo: the history row, and whether to set back keys that changed since. */
export interface UndoPermissionInput {
  /** The `permission.changed` event, from the history. */
  eventId: string;
  /** Set a key back even when it changed since the recorded change. */
  force?: true;
  /** The person just confirmed what Full autonomy means. */
  acknowledgeAutonomy?: true;
}

/**
 * The conflicts a refused Undo named (`409 UNDO_CONFLICT`): what changed since,
 * so the person can decide whether to set it back anyway. `null` for any other
 * failure.
 *
 * @param err - What the Undo threw.
 */
export function undoConflictsOf(err: unknown): PermissionUndoSkip[] | null {
  const failure = err as { code?: string; body?: { conflicts?: PermissionUndoSkip[] } } | null;
  if (failure?.code !== 'UNDO_CONFLICT') return null;
  return failure.body?.conflicts ?? [];
}

/**
 * Undo one change from the permission history (spec `agent-permissions` D14).
 * The server records the Undo as a new change, so every permission read, the
 * history, the mesh agent list and config (a preset moves the Files & commands
 * stop) are refreshed afterwards.
 *
 * Not optimistic, for the reason `useSetPermission` is not: a refused Undo must
 * leave every switch where it was.
 *
 * @returns The TanStack mutation.
 */
export function useUndoPermission() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, force, acknowledgeAutonomy }: UndoPermissionInput) =>
      transport.undoPermissionChange(eventId, {
        ...(force ? { force: true } : {}),
        ...(acknowledgeAutonomy ? { acknowledgeAutonomy: true as const } : {}),
      }),
    // The history row answers a refusal itself (the conflict question, or the
    // server's sentence), so the app-wide "Action failed" toast would repeat it.
    meta: { suppressErrorToast: true },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });
}
