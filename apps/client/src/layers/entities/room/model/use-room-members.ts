/**
 * Edit a room's roster — who is in it, and how each agent behaves there.
 *
 * The three routes behind these have existed since R1 and nothing in the
 * cockpit called them, which is why an agent's `responseMode` in a room was
 * fixed at join time and changeable only by editing the database (spec `rooms`
 * §12.4).
 *
 * All three are operator-only server-side: an agent can open a room for itself,
 * but only the person running the machine decides who else is in one.
 *
 * @module entities/room/model/use-room-members
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Refresh the room list and one room's detail after a roster write.
 *
 * Deliberately NOT `roomKeys.all`: that prefix-matches `['rooms','entries',id]`,
 * so it would refetch the open room's history and could overwrite an entry the
 * SSE stream has already delivered but the in-flight GET predates. The history
 * belongs to the stream; only the list and the roster are a roster write's to
 * refresh.
 */
function useRosterInvalidation(): (roomId: string) => void {
  const queryClient = useQueryClient();
  return (roomId: string) => {
    void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
    void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
  };
}

/**
 * One room with a single member's response mode replaced.
 *
 * Only that member is rewritten and the rest of the roster is the object the
 * cache already holds, which is what makes the rollback below safe while a
 * second member's write is still in flight: restoring a whole snapshot of the
 * room would quietly take that one back too.
 */
function withMemberMode(
  room: RoomWithRoster,
  authorId: string,
  responseMode: ResponseMode
): RoomWithRoster {
  return {
    ...room,
    members: room.members.map((member) =>
      member.authorId === authorId ? { ...member, responseMode } : member
    ),
  };
}

/** Which agent to put in which room. */
export interface AddRoomMemberInput {
  /** The room being joined. */
  roomId: string;
  /**
   * The agent's directory — its stable identity across re-registration
   * (ADR 260726-170126). An agent that has never been in a room gets its author
   * row minted in the same transaction.
   */
  agentPath: string;
  /**
   * The mode to join on, for a caller putting a member **back** that knows what
   * it held.
   *
   * Omit for a first join: the server's seed is the right answer there, and the
   * only one that reads an agent's own manifest. An undo is the case that must
   * NOT omit it — the seed for a channel is `engaged`, so re-adding without
   * this turns an agent somebody had set to Silent into one that answers, and
   * calls that "undo".
   */
  responseMode?: ResponseMode;
}

/**
 * Put an agent in a room.
 *
 * It joins **in place** and can read everything already said there. That is the
 * deliberate difference from Slack, which forks a new conversation instead: its
 * reason is privacy between people who do not own each other's accounts, and
 * every participant here is one of your own agents — while forking would strand
 * the conversation you were in the middle of (spec `rooms` §12.4).
 *
 * `responseMode` is left to the server unless the caller names one, and the
 * server seeds it from the room kind: the agent's manifest default for a direct
 * message, `engaged` for a channel (`CHANNEL_RESPONSE_MODE` in
 * `services/rooms/room-roster.ts`). `engaged` is the only bounded choice —
 * `mention-only` taxes a person with an `@` on every single message, and
 * `always` is agent dominance by construction — so a new arrival answers when
 * it is spoken to and then decays back to quiet.
 */
export function useAddRoomMember(): UseMutationResult<RoomRosterEntry, Error, AddRoomMemberInput> {
  const transport = useTransport();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, agentPath, responseMode }: AddRoomMemberInput) =>
      transport.addRoomMember(roomId, {
        agentPath,
        ...(responseMode === undefined ? {} : { responseMode }),
      }),
    onSuccess: (_member, { roomId }) => invalidate(roomId),
    // The shared mutation toast reads this with the server's own sentence after
    // it: "Couldn't add that agent — Only you can change who is in a room".
    meta: { errorLabel: "Couldn't add that agent" },
  });
}

/** Which member to take out of which room. */
export interface RemoveRoomMemberInput {
  /** The room being left. */
  roomId: string;
  /** The member's opaque author id. */
  authorId: string;
}

/**
 * Take a member out of a room.
 *
 * Its per-room session binding goes with it, so an agent added back afterwards
 * starts a fresh session rather than resuming the one it had — which is why the
 * caller confirms first. What the agent already said stays in the log; a room
 * that forgets what was said is not a room.
 */
export function useRemoveRoomMember(): UseMutationResult<void, Error, RemoveRoomMemberInput> {
  const transport = useTransport();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, authorId }: RemoveRoomMemberInput) =>
      transport.removeRoomMember(roomId, authorId),
    onSuccess: (_void, { roomId }) => invalidate(roomId),
    meta: { errorLabel: "Couldn't remove that agent" },
  });
}

/** Which room to leave, naming yourself as the member coming off it. */
export interface LeaveRoomInput {
  /** The room being left. */
  roomId: string;
  /**
   * Your own author id. Leaving is not a verb the server has a name for —
   * `DELETE /:id/members/:authorId` with your own id as the target IS leaving
   * — so the caller has to already know who "you" are on this install (the
   * team roster's `isSelf` row answers that).
   */
  authorId: string;
}

/**
 * Leave a room you belong to.
 *
 * The wire call is {@link useRemoveRoomMember}'s, verbatim, with your own id
 * as the target — but it is its own mutation rather than a second caller of
 * that hook. `meta.errorLabel` is fixed per mutation instance, and "Couldn't
 * remove that agent" is not a sentence about yourself.
 *
 * **Refused while two agents still share the room and nobody would be left to
 * witness them** — `OWNER_MUST_BE_PRESENT`, the three-way rule
 * (ADR 260814-025326). Take one of them out first, or archive the room
 * instead; the server's own sentence explains which, and the shared mutation
 * toast is what shows it (`meta.errorLabel` composed with `error.message`).
 */
export function useLeaveRoom(): UseMutationResult<void, Error, LeaveRoomInput> {
  const transport = useTransport();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, authorId }: LeaveRoomInput) =>
      transport.removeRoomMember(roomId, authorId),
    onSuccess: (_void, { roomId }) => invalidate(roomId),
    meta: { errorLabel: "Couldn't leave" },
  });
}

/** Which member's response mode to change, and to what. */
export interface SetResponseModeInput {
  /** The room the override applies to. */
  roomId: string;
  /** The member being changed. */
  authorId: string;
  /** How that agent should decide when to reply here. */
  responseMode: ResponseMode;
}

/** What a failed mode change has to put back. */
interface ResponseModeRollback {
  /**
   * The mode this member held before the optimistic write, or `undefined` when
   * the roster was not in the cache to read one from — in which case there is
   * nothing to restore and the refetch is the only answer.
   */
  previous: ResponseMode | undefined;
}

/**
 * Change one agent's per-room response mode — this room's override of the
 * agent's manifest default.
 *
 * This is the setting that decides when an agent replies without being
 * addressed, so it is what makes a channel holding two `always` agents
 * survivable.
 *
 * **Written to the cache before the server has agreed, and taken back if it
 * does not.** The control this drives is a meter that moves, so the value
 * arriving a round trip late reads as a control that did not respond; and
 * leaving the chosen value on screen after a refusal is worse than showing
 * nothing at all, because the control then states a setting that was never
 * stored. So the roster is patched at once and the one member's mode is put
 * back on failure.
 *
 * The rollback restores that member's mode alone rather than the snapshot of
 * the whole room — see {@link withMemberMode} — so a second member's write that
 * is still in flight is not taken back along with it.
 *
 * `onSettled` rather than `onSuccess`, because a failed write leaves the cache
 * holding a value this client invented and the server's copy is the only way
 * back to the truth. Still never `roomKeys.all`: see {@link useRosterInvalidation}.
 */
export function useSetMemberResponseMode(): UseMutationResult<
  RoomRosterEntry,
  Error,
  SetResponseModeInput,
  ResponseModeRollback
> {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, authorId, responseMode }: SetResponseModeInput) =>
      transport.updateRoomMember(roomId, authorId, { responseMode }),
    onMutate: async ({ roomId, authorId, responseMode }) => {
      // A read already on the wire predates this change and would land on top
      // of it, putting the old rung back under a reader who is watching the
      // meter move.
      await queryClient.cancelQueries({ queryKey: roomKeys.detail(roomId) });
      const cached = queryClient.getQueryData<RoomWithRoster>(roomKeys.detail(roomId));
      const previous = cached?.members.find((member) => member.authorId === authorId)?.responseMode;
      queryClient.setQueryData<RoomWithRoster>(roomKeys.detail(roomId), (room) =>
        room === undefined ? room : withMemberMode(room, authorId, responseMode)
      );
      return { previous };
    },
    onError: (_error, { roomId, authorId }, rollback) => {
      const previous = rollback?.previous;
      if (previous === undefined) return;
      queryClient.setQueryData<RoomWithRoster>(roomKeys.detail(roomId), (room) =>
        room === undefined ? room : withMemberMode(room, authorId, previous)
      );
    },
    onSettled: (_member, _error, { roomId }) => invalidate(roomId),
    meta: { errorLabel: "Couldn't change how that agent replies" },
  });
}
