/**
 * The three writes that edit the person at the keyboard.
 *
 * Each one changes a field the roster renders, so each one invalidates the
 * roster — which is what makes the sidebar's account disc, the Team page and
 * every room's author row agree a moment after a photo lands, without any of
 * them knowing this hook exists.
 *
 * Each one also invalidates every open room's detail query (DOR-1114): a
 * room's author row is drawn from its own cached roster, not from `['team']`,
 * so an idle open room could keep a renamed operator's old name in the
 * message gutter until an unrelated refetch touched it.
 *
 * @module features/profile/model/use-profile-edits
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';

/** Refresh the roster and every open room's roster after a profile write. */
function invalidateProfileReaders(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: [...TEAM_ROSTER_KEY] });
  void queryClient.invalidateQueries({ queryKey: roomKeys.details() });
}

/** What a photo write needs: the bytes and a name for the multipart part. */
export interface AvatarUpload {
  /** The chosen file. */
  file: File;
}

/**
 * Save what the operator wants to be called.
 *
 * @returns A TanStack mutation taking the new display name.
 */
export function useUpdateProfileName() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (displayName: string) => transport.updateProfile(displayName),
    onSuccess: () => invalidateProfileReaders(queryClient),
  });
}

/**
 * Replace the operator's photo.
 *
 * @returns A TanStack mutation taking the chosen file.
 */
export function useUploadProfileAvatar() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ file }: AvatarUpload) => transport.uploadProfileAvatar(file, file.name),
    onSuccess: () => invalidateProfileReaders(queryClient),
  });
}

/**
 * Remove the operator's photo, falling their disc back to emoji then initial.
 *
 * @returns A TanStack mutation taking nothing.
 */
export function useDeleteProfileAvatar() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => transport.deleteProfileAvatar(),
    onSuccess: () => invalidateProfileReaders(queryClient),
  });
}

/**
 * Claim or change an `@handle`.
 *
 * **The handles spec's own route, and no second one** (`handles` S6): this is a
 * thin call over `PATCH /api/rooms/authors/:id/handle`, so the invariant that
 * nothing agent-reachable writes a handle stays a property of one route rather
 * than a rule two routes have to keep agreeing on.
 *
 * @returns A TanStack mutation taking the author id and the wanted handle.
 */
export function useSetAuthorHandle() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ authorId, handle }: { authorId: string; handle: string }) =>
      transport.setAuthorHandle(authorId, handle),
    onSuccess: () => invalidateProfileReaders(queryClient),
  });
}
