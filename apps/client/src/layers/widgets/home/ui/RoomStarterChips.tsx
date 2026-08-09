import { useCallback } from 'react';
import { PromptSuggestionChips } from '@/layers/shared/ui';
import { useComposerFocusStore, useRoomDraftStore } from '@/layers/entities/room';
import { HOME_STARTER_CHIPS } from '../lib/starter-chips';

/** What {@link RoomStarterChips} writes into. */
export interface RoomStarterChipsProps {
  /**
   * The room whose composer these chips fill.
   *
   * It is also the composer's draft key — the room's own box, never a thread
   * panel's — so a press lands in the field directly underneath the chips.
   */
  roomId: string;
}

/**
 * The opening lines, above the composer, on a room that has nothing in it yet.
 *
 * Day one of #team is a conversation waiting to start, and a blank box is a poor
 * invitation (team-room-home spec D3.6). These are four things worth saying,
 * drawn with the same chip chat uses for its own suggestions — one chip
 * component in this app, so a chip means the same thing wherever it appears.
 *
 * **A press writes; it does not send.** The line goes into the composer's draft
 * and the caret follows it there, so the first message anybody sends is still
 * one they chose to send — edited, added to, or deleted. That is also why these
 * are lines rather than buttons that open something: what starts here is a
 * conversation with the room's own agent, and it starts the same way every later
 * message does.
 *
 * The host decides when these are on screen: they are for a room with no
 * history, and they go the moment there is a real conversation to read instead.
 *
 * @param props - The room to write into.
 */
export function RoomStarterChips({ roomId }: RoomStarterChipsProps) {
  const take = useCallback(
    (line: string) => {
      // Straight to the store rather than through a render closure: this is the
      // same draft the composer below is reading, and writing it here is what
      // makes the words appear in the box the reader is looking at.
      useRoomDraftStore.getState().set(roomId, line);
      // And the caret goes with them, so the next keystroke edits the line
      // instead of landing nowhere.
      useComposerFocusStore.getState().requestFocus(roomId);
    },
    [roomId]
  );

  return (
    <div className="w-full px-[var(--msg-padding-x)] pb-1">
      {/* `comfortable`, because on this screen these ARE the call to action —
          the only thing worth pressing on a room with nothing in it, and on a
          phone they have to be a real target rather than an afterthought under
          an answer. Chat keeps the compact size it has always had. */}
      <PromptSuggestionChips
        suggestions={HOME_STARTER_CHIPS}
        onChipClick={take}
        ariaLabel="Ways to start"
        size="comfortable"
      />
    </div>
  );
}
