import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ChatInput, type ChatInputHandle } from '@/layers/features/chat';
import {
  MentionPalette,
  useMentionAutocomplete,
  type MentionRow,
} from '@/layers/features/mentions';
import {
  roomDisplayTitle,
  useRoomDraft,
  useRoomDraftStore,
  usePostToRoom,
  type RoomWithRoster,
} from '@/layers/entities/room';

interface RoomComposerProps {
  /** The room on screen. Its archived flag decides whether posting is offered. */
  room: RoomWithRoster;
}

/**
 * Say something in a room.
 *
 * The same composer session chat uses, so Enter, Shift+Enter and the send
 * button all mean here what they mean there — and so a room does not acquire a
 * second, subtly different text box.
 *
 * The message round-trips: nothing is drawn until the server's copy arrives on
 * the room's stream, which is also the only way a second reader — or the agents
 * the post triggers — would ever see it. The box empties the moment you press
 * Enter, the way session chat's does, so the next sentence can be typed while
 * the first is still in the air.
 *
 * This component holds no draft of its own. The text belongs to the ROOM
 * (`useRoomDraft`), which is what lets it survive being navigated away from,
 * and lets a refused message find its way back to a composer that by then may
 * not exist.
 *
 * Typing `@` opens the mention picker over this room's roster. It writes the
 * handle the SERVER resolves rather than the name on screen, which is what
 * turns "did that reach anyone?" into something you can see before you send.
 * The composer stays the shared `ChatInput` — it already carries every palette
 * prop; only the panel above it is new.
 */
export function RoomComposer({ room }: RoomComposerProps) {
  const text = useRoomDraft(room.id);
  const post = usePostToRoom();
  const inputRef = useRef<ChatInputHandle>(null);

  const mentions = useMentionAutocomplete({
    members: room.members,
    viewerAuthorId: room.viewerAuthorId,
    text,
  });

  const setDraft = useCallback(
    (next: string) => useRoomDraftStore.getState().set(room.id, next),
    [room.id]
  );

  /**
   * Where the caret belongs once the inserted text has actually been painted.
   *
   * It cannot be moved in the same breath as the insert. Writing the draft only
   * schedules a render, and React then assigns the new value to the textarea —
   * which drops the caret at the very END of the field. A `focusAt` issued
   * before that runs is silently undone, so a mention inserted mid-sentence
   * throws the caret past the rest of the sentence.
   *
   * **State, and a fresh object every time — deliberately not a ref keyed on the
   * text.** An insert can produce a string identical to the draft it replaces:
   * the picker reopens on a bare caret move, so putting the caret back after
   * `@ana` in `hey @ana there` and pressing Enter re-inserts what is already
   * written. Keyed on the text, that render never happens, the caret is never
   * moved, and the request stays armed to fire on some later, unrelated edit —
   * yanking the caret mid-sentence one keystroke afterwards. A new object is a
   * new dependency whether or not the text moved, so every request has exactly
   * one consumer, in the commit that follows it.
   */
  const [pendingCaret, setPendingCaret] = useState<{ pos: number } | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    // Also returns focus to the composer, which is what a click on a row costs:
    // the pointer left focus on the panel, and the panel is now gone.
    inputRef.current?.focusAt(pendingCaret.pos);
  }, [pendingCaret]);

  /** Take a row: rewrite the draft, and book the caret for after the repaint. */
  const takeInsert = useCallback(
    (result: { value: string; cursorPos: number } | null) => {
      if (!result) return;
      setDraft(result.value);
      setPendingCaret({ pos: result.cursorPos });
    },
    [setDraft]
  );

  const takeRow = useCallback(
    (row: MentionRow) => takeInsert(mentions.selectRow(row)),
    [mentions, takeInsert]
  );

  const takeHighlighted = useCallback(
    () => takeInsert(mentions.selectHighlighted()),
    [mentions, takeInsert]
  );

  const handleSubmit = () => {
    if (room.archived) return;
    // Sending takes the picker down with it: Enter reaches this path only when
    // there was no row to pick, and nothing else would close a "No one by that
    // name." panel until the next keystroke.
    mentions.dismiss();
    // Read-and-clear straight from the store, never from `text` above. That
    // render closure is one render stale for a second Enter arriving in the
    // same tick, and would send the same sentence twice; the store has already
    // been emptied by then, so the second submit finds nothing and stops.
    const body = useRoomDraftStore.getState().take(room.id).trim();
    if (body === '') return;
    // No per-call callbacks: a refusal is handled by the mutation itself, which
    // still runs when this composer is gone. See `usePostToRoom`.
    post.mutate({ roomId: room.id, text: body });
  };

  return (
    <div className="relative border-t p-3">
      <div className="absolute right-3 bottom-full left-3 mb-2">
        <AnimatePresence>
          {mentions.isOpen && (
            <MentionPalette
              rows={mentions.rows}
              selectedIndex={mentions.selectedIndex}
              onSelect={takeRow}
            />
          )}
        </AnimatePresence>
      </div>
      <ChatInput
        ref={inputRef}
        value={text}
        onChange={(next) => {
          setDraft(next);
          // Records the text only. `onCursorChange` fires immediately after
          // with the REAL caret, and that is what runs trigger detection —
          // guessing the caret here is wrong for any edit not at the end.
          mentions.noteTextChange(next);
        }}
        onCursorChange={mentions.handleCursorChange}
        onSubmit={handleSubmit}
        isStreaming={false}
        isPaletteOpen={mentions.isOpen}
        paletteHasResults={mentions.hasSelectableRows}
        onArrowUp={mentions.moveUp}
        onArrowDown={mentions.moveDown}
        onCommandSelect={takeHighlighted}
        onEscape={mentions.dismiss}
        activeDescendantId={mentions.activeDescendantId}
        paletteListboxId={mentions.listboxId}
        // Deliberately NOT gated on a post being in flight. Sending is a
        // fire-and-forget 202, and closing the submit path for its duration
        // would block the second sentence of anyone who types faster than the
        // network — silently, since a refused submit says nothing.
        canSubmit={!room.archived}
        canSubmitReason={
          room.archived
            ? 'This conversation is archived. You can read it, but not add to it.'
            : undefined
        }
        // Ties the pending double-Escape wipe to this room, so an arm raised in
        // one conversation cannot clear the draft of the next one.
        contextKey={room.id}
        placeholder={`Message ${roomDisplayTitle(room)}…`}
      />
    </div>
  );
}
