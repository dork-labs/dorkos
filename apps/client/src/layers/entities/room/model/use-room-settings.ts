/**
 * Change what a room is — its name, its topic, whether it is archived.
 *
 * Four hooks rather than one `updateRoom`, for two reasons that are really the
 * same reason.
 *
 * **Each names its own failure.** The shared mutation toast composes
 * `meta.errorLabel` with the server's own sentence — "Couldn't bring that room
 * back — A channel called #backend already exists" — and that only reads
 * correctly when the label says which attempt failed. One hook serving rename,
 * topic and archive could carry only a label vague enough to fit all three.
 *
 * **And `meta` is the only error path that survives its caller.** Archiving a
 * room unmounts the row that archived it, so the "Undo" offered afterwards runs
 * against an observer with no listeners — and TanStack gates per-call `onError`
 * callbacks on `hasListeners()`, so such a handler never fires. The mutation
 * cache's global handler is not gated. Routing errors through `meta` is
 * therefore what makes a failed undo say why, instead of falling through to
 * "Action failed. Please try again." on a room the sidebar has already dropped.
 *
 * @module entities/room/model/use-room-settings
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Refresh the room list and one room's detail after a settings write.
 *
 * Deliberately NOT `roomKeys.all`: that prefix-matches `['rooms','entries',id]`,
 * so it would refetch the open room's history and could overwrite an entry the
 * SSE stream has already delivered but the in-flight GET predates. The history
 * belongs to the stream (see `use-mark-room-read.ts` for the full reasoning).
 */
function refreshRoom(queryClient: QueryClient, roomId: string): void {
  void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
  // The well-known lookup is not under the list prefix (`roomKeys.wellKnown`
  // says why), so it is named here as well. Archiving and un-archiving #team
  // both land in this function, and the home tab reads that lookup to decide
  // which of the two it is currently showing — without this, bringing the room
  // back left Home still saying it was put away.
  void queryClient.invalidateQueries({ queryKey: roomKeys.wellKnowns() });
}

/** Which room to rename, and to what. */
export interface RenameRoomInput {
  roomId: string;
  /** The new title. A channel's `#slug` moves with it, server-side. */
  title: string;
}

/**
 * Rename a room.
 *
 * Renaming a channel moves its `#slug` too — a channel's name IS its slug — so
 * this is refused when another live channel already holds the name the new
 * title slugs to, or when the title has nothing sluggable in it.
 */
export function useRenameRoom(): UseMutationResult<RoomWithRoster, Error, RenameRoomInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, title }: RenameRoomInput) => transport.updateRoom(roomId, { title }),
    onSuccess: (_room, { roomId }) => refreshRoom(queryClient, roomId),
    meta: { errorLabel: "Couldn't rename that room" },
  });
}

/** Which room's topic to set, and to what. `null` removes it. */
export interface SetRoomTopicInput {
  roomId: string;
  topic: string | null;
}

/** Say what a channel is about, or clear it with `null`. */
export function useSetRoomTopic(): UseMutationResult<RoomWithRoster, Error, SetRoomTopicInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, topic }: SetRoomTopicInput) => transport.updateRoom(roomId, { topic }),
    onSuccess: (_room, { roomId }) => refreshRoom(queryClient, roomId),
    meta: { errorLabel: "Couldn't change that topic" },
  });
}

/**
 * Archive a room: it leaves the sidebar and stops triggering its agents.
 *
 * Reversible through {@link useUnarchiveRoom}, which is what makes "Archive"
 * the honest verb rather than a delete wearing a softer word.
 */
export function useArchiveRoom(): UseMutationResult<RoomWithRoster, Error, string> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (roomId: string) => transport.updateRoom(roomId, { archived: true }),
    onSuccess: (_room, roomId) => refreshRoom(queryClient, roomId),
    meta: { errorLabel: "Couldn't archive that room" },
  });
}

/** Which room to bring back, and optionally under what name. */
export interface UnarchiveRoomInput {
  roomId: string;
  /**
   * A new title to come back under. A channel's slug is only reserved while it
   * is live, so un-archiving has to reclaim one and can find it taken — coming
   * back under a different name is the way out of that, and the server applies
   * the new slug before it checks whether the room may be un-archived.
   */
  title?: string;
}

/** Which bridged room to change, and whether its chat hears about stalls. */
export interface SetDeliverNoticesInput {
  roomId: string;
  /** True: a failed or stopped turn posts a plain note into the bridged chat. */
  deliverNotices: boolean;
}

/**
 * Choose whether a bridged chat hears when a turn fails or is stopped
 * (chats-as-channels spec §6.2). Valid only on a bridged room — the server
 * refuses this on any other with `NOT_A_BRIDGED_ROOM`, which the shared toast
 * surfaces with the label below.
 */
export function useSetDeliverNotices(): UseMutationResult<
  RoomWithRoster,
  Error,
  SetDeliverNoticesInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, deliverNotices }: SetDeliverNoticesInput) =>
      transport.updateRoom(roomId, { deliverNotices }),
    onSuccess: (_room, { roomId }) => refreshRoom(queryClient, roomId),
    meta: { errorLabel: "Couldn't change what reaches the chat" },
  });
}

/**
 * What one room may say about its own automatic-reply limits.
 *
 * Every field is optional and nullable, exactly as `UpdateRoomRequest` has it,
 * and the two absences mean different things: leaving a field out changes
 * nothing, while sending `null` clears the override and puts the room back to
 * following Settings. A caller that means "clear this" must send the `null` —
 * `undefined` is silently a no-op.
 */
export interface SetRoomLimitsInput {
  roomId: string;
  /** `true` limited here, `false` unlimited here, `null` follow Settings. */
  turnLimitsEnabled?: boolean | null;
  /** Replies in a row allowed here, or `null` to follow Settings. */
  maxAgentDepth?: number | null;
  /** Replies from one agent allowed here, or `null` to follow Settings. */
  maxTurnsPerAgentPerCascade?: number | null;
  /** Replies this room may run in an hour, or `null` to follow Settings. */
  maxAutoTurnsPerHour?: number | null;
}

/**
 * Give one room limits of its own, or hand any of them back to Settings.
 *
 * **Operator-only, and the server is what enforces it** (403 `OPERATOR_ONLY`,
 * `RoomService.updateRoom`). These four fields are spend authority: turning a
 * room's limits off removes its cascade guard and its hourly ceiling in one
 * write, and everything billed after that lands on whoever owns the install. So
 * the gate is the install's owner, not merely a person — an agent could never
 * write them, and neither can a second human who was invited into the room.
 * `roomLimitsErrorMessage` is what turns that refusal into a sentence.
 *
 * **Optimistic, because the control the reader pressed is the control this
 * changes.** Every value here is read straight off the room's own record, so
 * without this the radio they just chose would visibly jump back to the old
 * stance for the length of a round trip and then forward again. The write lands
 * on the cached room, rolls back on failure, and is confirmed by a refetch when
 * it settles.
 *
 * That refetch is not optional bookkeeping: `room_updated` fans out over SSE
 * WITHOUT these fields on it, so nothing else would tell an open panel — here or
 * in a second window — that a limit moved.
 */
export function useSetRoomLimits(): UseMutationResult<
  RoomWithRoster,
  Error,
  SetRoomLimitsInput,
  { previous: RoomWithRoster | undefined }
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, ...limits }: SetRoomLimitsInput) => transport.updateRoom(roomId, limits),
    onMutate: async ({ roomId, ...limits }) => {
      const key = roomKeys.detail(roomId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RoomWithRoster>(key);
      queryClient.setQueryData<RoomWithRoster>(key, (old) =>
        // Nothing to patch when the room is not in the cache yet; the
        // settle-time refresh reads it whole.
        old ? { ...old, ...limits } : old
      );
      return { previous };
    },
    onError: (_error, { roomId }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(roomKeys.detail(roomId), context.previous);
      }
    },
    onSettled: (_room, _error, { roomId }) => refreshRoom(queryClient, roomId),
    // The section renders the refusal itself, under the control that was
    // refused, so the shared toast would be the same failure said twice in two
    // voices — the case `query-client.ts` documents this opt-out for. It is also
    // the only refusal here a person can act on, and acting on it means reading
    // WHICH install owner they are not, which a toast that has already faded
    // cannot tell them.
    meta: { suppressErrorToast: true },
  });
}

/** Bring an archived room back. */
export function useUnarchiveRoom(): UseMutationResult<RoomWithRoster, Error, UnarchiveRoomInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, title }: UnarchiveRoomInput) =>
      transport.updateRoom(roomId, { archived: false, ...(title === undefined ? {} : { title }) }),
    onSuccess: (_room, { roomId }) => refreshRoom(queryClient, roomId),
    meta: { errorLabel: "Couldn't bring that room back" },
  });
}
