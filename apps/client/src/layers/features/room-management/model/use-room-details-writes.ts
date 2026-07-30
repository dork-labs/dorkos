/**
 * Everything the room sheet writes, and what each write is doing right now.
 *
 * Split out for the same reason the reads were: the sheet composes six parts and
 * owns three mutations, and the interesting half of a mutation here is not the
 * call but what the surface says while it is in flight and after it fails.
 * Gathered in one place, "what happens when this does not work" can be read as
 * one answer rather than found in three call sites.
 *
 * @module features/room-management/model/use-room-details-writes
 */
import { useCallback } from 'react';
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import {
  modeForRung,
  useAddRoomMember,
  useRemoveRoomMember,
  useSetMemberResponseMode,
  type ResponseRung,
} from '@/layers/entities/room';

/** Which write failed, and what the server said about it. */
export interface WriteFailure {
  /** The member the failed write was about. */
  authorId: string;
  /** The server's own sentence. */
  message: string;
}

/** The sheet's three writes, and the state a reader can see them in. */
export interface RoomDetailsWrites {
  /** Put these agents in the room — one call each, in the order they were picked. */
  addAgents: (chosen: readonly AgentPickerCandidate[]) => void;
  /** True while an add is in flight, so the picker's commit button can wait. */
  isAdding: boolean;
  /** Commit a rung for one member. */
  setRung: (member: RoomRosterEntry, rung: ResponseRung) => void;
  /** Whose rung is being written right now, or `null` when none is. */
  savingRungFor: string | null;
  /** The last rung change that failed, or `null` when the last one did not. */
  rungFailure: WriteFailure | null;
  /** Take a member out of the room. The caller has already confirmed it. */
  removeMember: (member: RoomRosterEntry) => void;
}

/** What the writes need to know about the room they are writing to. */
export interface RoomDetailsWritesInput {
  /** The room being changed. */
  roomId: string;
  /**
   * The kind the SERVER most recently reported, never the caller's copy: two of
   * the five stored response modes mean different things in a channel and in a
   * direct message, so a rung projected through the wrong kind stores the wrong
   * behaviour.
   */
  roomKind: RoomKind;
}

/**
 * The room sheet's writes, with the reporting each one needs.
 *
 * **Nothing here raises a success toast.** Every one of these writes changes
 * something the reader is already looking at — the meter moves, the row leaves
 * the roster, the chip disappears — and a toast confirming a change somebody
 * just watched happen is a notification about their own hand.
 *
 * **Nothing here raises an error toast either.** The shared mutation toast
 * already composes each hook's `meta.errorLabel` with the server's own sentence,
 * and it is the only report that survives this sheet being closed mid-write — a
 * per-call `onError` is dispatched only while the observer still has listeners.
 * A second toast raised here would mean two lines for one failure.
 *
 * @param input - The room being written to.
 */
export function useRoomDetailsWrites(input: RoomDetailsWritesInput): RoomDetailsWrites {
  const { roomId, roomKind } = input;
  const addMember = useAddRoomMember();
  const removeRoomMember = useRemoveRoomMember();
  const setResponseMode = useSetMemberResponseMode();

  const addAgents = useCallback(
    (chosen: readonly AgentPickerCandidate[]) => {
      // One call per agent: the roster endpoint adds one member at a time, and a
      // partial success is still progress worth keeping, so a failure is
      // reported on its own rather than rolling the others back.
      //
      // Nothing is cleared here, and the sheet stays open. Each agent that lands
      // joins the roster, drops out of `candidates`, and takes its own chip with
      // it — so the selection empties at the rate the writes actually succeed,
      // and after three of four the reader is left holding the one that failed
      // rather than a button that would add the other three again.
      for (const agent of chosen) addMember.mutate({ roomId, agentPath: agent.agentPath });
    },
    [addMember, roomId]
  );

  const setRung = useCallback(
    (member: RoomRosterEntry, rung: ResponseRung) => {
      // A rung is what a person picks; a `responseMode` is what gets stored. One
      // canonical value per rung, so this sheet never writes one of the two
      // aliases whose meaning depends on which kind of room it ends up in.
      setResponseMode.mutate({
        roomId,
        authorId: member.authorId,
        responseMode: modeForRung(rung, roomKind),
      });
    },
    [setResponseMode, roomId, roomKind]
  );

  const removeMember = useCallback(
    (member: RoomRosterEntry) => {
      removeRoomMember.mutate({ roomId, authorId: member.authorId });
    },
    [removeRoomMember, roomId]
  );

  /**
   * Which member the pending and failed states belong to.
   *
   * One observer serves every row, so these follow the LATEST rung change
   * rather than tracking one per member. Two rung changes in flight at once
   * would move the dim from the first row to the second early — a change nobody
   * is misled by, because the value each row shows is the cache's and the cache
   * carries both writes. A per-member map would be a second source of truth for
   * a state the mutation already holds.
   */
  const rungAuthorId = setResponseMode.variables?.authorId ?? null;

  return {
    addAgents,
    isAdding: addMember.isPending,
    setRung,
    savingRungFor: setResponseMode.isPending ? rungAuthorId : null,
    rungFailure:
      setResponseMode.isError && rungAuthorId !== null
        ? { authorId: rungAuthorId, message: setResponseMode.error.message }
        : null,
    removeMember,
  };
}
