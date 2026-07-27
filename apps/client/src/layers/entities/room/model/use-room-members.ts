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
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
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
 * `responseMode` is left to the server, which seeds it from the room kind: the
 * agent's manifest default for a direct message, `mention-only` for a channel,
 * so a new arrival in a busy channel does not start answering everything.
 */
export function useAddRoomMember(): UseMutationResult<RoomRosterEntry, Error, AddRoomMemberInput> {
  const transport = useTransport();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, agentPath }: AddRoomMemberInput) =>
      transport.addRoomMember(roomId, { agentPath }),
    onSuccess: (_member, { roomId }) => invalidate(roomId),
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

/**
 * Change one agent's per-room response mode — this room's override of the
 * agent's manifest default.
 *
 * This is the setting that decides when an agent replies without being
 * addressed, so it is what makes a channel holding two `always` agents
 * survivable.
 */
export function useSetMemberResponseMode(): UseMutationResult<
  RoomRosterEntry,
  Error,
  SetResponseModeInput
> {
  const transport = useTransport();
  const invalidate = useRosterInvalidation();

  return useMutation({
    mutationFn: ({ roomId, authorId, responseMode }: SetResponseModeInput) =>
      transport.updateRoomMember(roomId, authorId, { responseMode }),
    onSuccess: (_member, { roomId }) => invalidate(roomId),
  });
}
