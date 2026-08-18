/**
 * `Message.Reactions` — the pills under a message.
 *
 * The pills themselves are `features/entry-actions`' business: a pill is a
 * toggle for the same act the capsule offers, and one slice owns what a
 * reaction means. This part is the row's socket for them, and the gate.
 *
 * **The gate is `capabilities.reactions`, never the surface.** A conversation
 * that cannot be reacted to draws nothing here at all — no rail, no ghost, not
 * even the socket — and neither does a reactable message nobody has reacted to
 * yet, which is what keeps a quiet room quiet.
 *
 * @module features/conversation/ui/message/MessageReactions
 */
import { useState, type Ref } from 'react';
import type { RoomEntryReaction } from '@dorkos/shared/room-schemas';
import { EntryReactionRow, type RovingGroupHandle } from '@/layers/features/entry-actions';
import { useConversation } from '../../model/conversation-context';

/** What the pill row needs. */
export interface MessageReactionsProps {
  /** The message's reactions, oldest pill first. Nothing is drawn when empty. */
  reactions: readonly RoomEntryReaction[];
  /** The reader's own author id here — which pills glow, and who "You" is. */
  viewerAuthorId: string;
  /** Display names by author id, the only place "You and LifeOS reacted" can come from. */
  names: ReadonlyMap<string, string>;
  /** The reader's most-used emoji, for the picker the ghost + opens. */
  frequents: readonly string[];
  /** Put one on, or take it back. */
  onToggle: (emoji: string) => void;
  /** True when reacting cannot land — a conversation whose stream has died. */
  disabled?: boolean;
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
  /** The pill group's handle, so the row can step into it with an arrow key. */
  ref?: Ref<RovingGroupHandle>;
}

/** The pills, under the words they are about — or nothing at all. */
export function MessageReactions({ ref, ...pills }: MessageReactionsProps) {
  const { capabilities } = useConversation();
  // Has this message EVER carried a pill? Latched rather than read fresh,
  // because the two "nothing to draw" cases are not the same case:
  //
  // - A message nobody has reacted to yet draws no socket at all. That is the
  //   overwhelmingly common row, and a wrapper on every one of them would put
  //   an element in the document that answers to `[data-slot="message-reactions"]`
  //   while offering nothing — which is what makes "the slot is absent" stop
  //   meaning "this conversation has no reactions".
  // - A message whose LAST pill has just been taken back still draws it. The
  //   pill leaves on a 120ms fade that `EntryReactionRow` deliberately outlives
  //   its own emptiness to run, and unmounting the socket underneath it would
  //   take `AnimatePresence` with it and swallow the fade entirely.
  //
  // Set during render, the same way `EntryReactionRow` decides its own linger,
  // and for the same reason: an effect runs after the commit, by which point
  // the `null` has already reached the DOM.
  const [everHadPills, setEverHadPills] = useState(pills.reactions.length > 0);
  if (!everHadPills && pills.reactions.length > 0) setEverHadPills(true);

  if (!capabilities.reactions || !everHadPills) return null;

  return (
    // `display: contents` — the part is named for tests and for the design
    // system's per-slot rules, and costs the row no box doing it. A real
    // wrapper here would put a block element between the column and the pill
    // row and change the spacing under every message that has one.
    <div data-slot="message-reactions" className="contents">
      <EntryReactionRow ref={ref} {...pills} />
    </div>
  );
}
