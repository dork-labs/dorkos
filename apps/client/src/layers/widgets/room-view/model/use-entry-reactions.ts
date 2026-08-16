/**
 * One message's reactions, as every surface that offers them needs them.
 *
 * A room message offers the same act in three places — the pills under the
 * words, the quick row in the hover capsule, and the row across the top of the
 * touch drawer — and all three toggle the same emoji for the same reader. This
 * hook is the one place that arithmetic happens, so a row hands the identical
 * `quickRow` to its menu and its toolbar rather than assembling two of them.
 *
 * @module widgets/room-view/model/use-entry-reactions
 */
import { useCallback, useMemo } from 'react';
import {
  hasReacted,
  useToggleReaction,
  type RoomEntry,
  type RoomEntryReaction,
} from '@/layers/entities/room';
import type { EntryActionBarReactions } from '@/layers/features/entry-actions';

interface UseEntryReactionsOptions {
  /** The room the entry lives in, which the toggle writes to. */
  roomId: string;
  /** The entry being reacted to. */
  entry: RoomEntry;
  /** The reader's own author id here — which pills glow, and who "You" is. */
  viewerAuthorId: string;
  /** This reader's three most-used emoji, as the server counted them. */
  reactionFrequents: readonly string[];
  /**
   * True when the room's live stream has given up. Reactions go with the
   * composer: a write whose result would never come back is worse than a
   * control that says it cannot be used (design record §4).
   */
  streamStalled?: boolean;
  /**
   * Whether the viewer is on this room's roster right now. Reactions go with
   * the composer for this reason too (DOR-1233): a reaction on a room the
   * owner left refuses the identical `MEMBER_NOT_FOUND` a post does. Defaults
   * `true`.
   */
  isMember?: boolean;
}

interface EntryReactions {
  /** The entry's pills, oldest first — an empty list when nobody has reacted. */
  reactions: readonly RoomEntryReaction[];
  /** Put an emoji on this message, or take it back. */
  toggle: (emoji: string) => void;
  /** The quick-reaction row, ready for the capsule and the touch drawer alike. */
  quickRow: EntryActionBarReactions;
}

/**
 * Build one message's reaction state and the single toggle that changes it.
 *
 * @param options - The entry, who is reading, and whether the room can still
 *   take a write.
 */
export function useEntryReactions({
  roomId,
  entry,
  viewerAuthorId,
  reactionFrequents,
  streamStalled,
  isMember = true,
}: UseEntryReactionsOptions): EntryReactions {
  const toggleReaction = useToggleReaction();
  const disabled = streamStalled === true || !isMember;

  const reactions = useMemo(() => entry.reactions ?? [], [entry.reactions]);
  const mine = useMemo(
    () => reactions.filter((r) => hasReacted(r, viewerAuthorId)).map((r) => r.emoji),
    [reactions, viewerAuthorId]
  );
  const toggle = useCallback(
    (emoji: string) => toggleReaction.mutate({ roomId, entryId: entry.id, emoji, viewerAuthorId }),
    [toggleReaction, roomId, entry.id, viewerAuthorId]
  );
  const quickRow = useMemo(
    () => ({
      quick: reactionFrequents,
      mine,
      onToggle: toggle,
      disabled,
    }),
    [reactionFrequents, mine, toggle, disabled]
  );

  return { reactions, toggle, quickRow };
}
