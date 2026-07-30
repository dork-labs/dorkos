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
import { toast } from 'sonner';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
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
  /** The room in prose, for the undo offer to name. */
  roomTitle: string;
  /**
   * Where a member's agent lives on disk, or `null` when the fleet cannot say.
   * Putting an agent back needs its directory, and a roster row carries only a
   * one-way hash of it — see `useRoomDetailsView`.
   */
  agentPathOf: (member: RoomRosterEntry) => string | null;
}

/**
 * The room sheet's writes, with the reporting each one needs.
 *
 * **Only one of them says anything on success, and it is the one carrying an
 * undo.** Every write here changes something the reader is already looking at —
 * the meter moves, the row leaves the roster, the chip disappears — so a toast
 * confirming it is a notification about their own hand. Removal is the
 * exception, because what it destroys is invisible: the agent's per-room
 * session binding goes with the membership, so an agent added back afterwards
 * starts fresh. Archiving a whole room has offered an undo since it shipped;
 * taking one agent out of one room is the narrower act and had none.
 *
 * **Nothing here raises an error toast.** The shared mutation toast already
 * composes each hook's `meta.errorLabel` with the server's own sentence, and it
 * is the only report that survives this sheet being closed mid-write — a
 * per-call `onError` is dispatched only while the observer still has listeners.
 * A second toast raised here would mean two lines for one failure.
 *
 * **The one report this file does raise is read off a promise, not off a
 * per-call callback.** Those callbacks live in a single slot on the mutation
 * observer, and every row shares one observer — so two removals in flight at
 * once cost the first one its offer. See {@link RoomDetailsWrites.removeMember}.
 *
 * @param input - The room being written to.
 */
export function useRoomDetailsWrites(input: RoomDetailsWritesInput): RoomDetailsWrites {
  const { roomId, roomTitle, agentPathOf } = input;
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
      // canonical value per rung, so this sheet never writes `direct-only` —
      // the one value whose meaning depends on which kind of room it ends up
      // in. The kind is not read here for the same reason it is not an argument
      // to `modeForRung`: nothing about the write depends on it.
      setResponseMode.mutate({
        roomId,
        authorId: member.authorId,
        responseMode: modeForRung(rung),
      });
    },
    [setResponseMode, roomId]
  );

  const removeMember = useCallback(
    (member: RoomRosterEntry) => {
      // Both read BEFORE the write. Afterwards the roster no longer holds this
      // membership, so there is nothing left to read the mode off — and an undo
      // that re-adds without it takes the server's join-time seed instead,
      // which for a channel is `engaged`. That would turn an agent somebody had
      // deliberately set to Silent into one that answers, and call it undo.
      const { responseMode } = member;
      const agentPath = agentPathOf(member);
      // Settled from the MUTATION's own promise rather than from a per-call
      // `onSuccess`. One observer serves every row and TanStack keeps ONE slot
      // for per-call callbacks (`MutationObserver`'s `#mutateOptions`), so a
      // second removal started before the first has landed overwrites the first
      // call's handlers and that agent leaves with no way back — while what the
      // removal destroyed, its per-room session binding, is invisible. The
      // promise `mutateAsync` returns belongs to one call and settles whatever
      // else the observer goes on to do. Same fix, and the same reasoning, as
      // the queued `/rename` in `use-native-commands.ts` (DOR-480).
      //
      // Serialising the removals would hide this rather than fix it: the second
      // agent would wait on the first for no reason the reader can see.
      removeRoomMember
        .mutateAsync({ roomId, authorId: member.authorId })
        .then(() => {
          const offer = `${member.author.displayName} removed from ${roomTitle}`;
          // Nothing is said at all when there is no way back to offer: the
          // row leaving the roster is the confirmation, and a toast with no
          // verb on it is a notification about something already on screen.
          // An agent with no directory the fleet can name is one that has
          // left the mesh, and nothing could put it back.
          if (agentPath === null) return;
          toast.success(offer, {
            action: {
              label: 'Undo',
              onClick: () => addMember.mutate({ roomId, agentPath, responseMode }),
            },
          });
        })
        // The rejection arm is what makes this safe to leave unawaited, and it
        // stays empty on purpose: the shared mutation toast already composes
        // this hook's `meta.errorLabel` with the server's own sentence, from
        // the mutation cache, which is not gated on anybody still listening. A
        // second report here would mean two lines for one failure.
        .catch(() => {});
    },
    [removeRoomMember, addMember, roomId, roomTitle, agentPathOf]
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
