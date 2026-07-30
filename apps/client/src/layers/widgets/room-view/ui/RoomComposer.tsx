import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Reply, X } from 'lucide-react';
import { ChatInput, type ChatInputHandle } from '@/layers/features/chat';
import {
  MentionPalette,
  useMentionAutocomplete,
  type MentionRow,
} from '@/layers/features/mentions';
import {
  roomDisplayTitle,
  useComposerFocusRequest,
  useRoomDraft,
  useRoomDraftStore,
  useRoomEntries,
  useRoomReplyTarget,
  useRoomReplyTargetStore,
  usePostToRoom,
  useReplyInThread,
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
 *
 * **One composer, two destinations.** Choosing "Reply in thread" on a message
 * aims this box at that thread until you aim it back; a line above the input
 * says so and takes it back. There is no second text box for threads, because
 * a room with two composers has to answer "which one am I typing in?" on every
 * keystroke, and the answer would be a matter of which one has focus.
 *
 * The aim SURVIVES sending, so an exchange inside a thread is a conversation
 * rather than a sequence of re-aiming. That is only honest while the banner is
 * unmissable — it is what keeps a reply from silently becoming a room-wide post
 * or the reverse.
 */
export function RoomComposer({ room }: RoomComposerProps) {
  const text = useRoomDraft(room.id);
  const post = usePostToRoom();
  const reply = useReplyInThread();
  const replyTo = useRoomReplyTarget(room.id);
  const focusRequest = useComposerFocusRequest(room.id);
  const inputRef = useRef<ChatInputHandle>(null);

  const mentions = useMentionAutocomplete({
    members: room.members,
    viewerAuthorId: room.viewerAuthorId,
    text,
  });

  /**
   * Take the caret when a message asked for it.
   *
   * The request is a counter rather than a flag, so two replies in a row are two
   * requests; the ref is what keeps this from firing on a value that merely
   * happened to be non-zero when the composer mounted — coming back to a room
   * you once replied in is not a request for its keyboard.
   *
   * `focus`, not `focusUnlessTouch`: pressing "Reply in thread" IS asking, and
   * on a phone the point of the press is to type.
   */
  const lastFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = focusRequest;
    inputRef.current?.focus();
  }, [focusRequest]);

  /**
   * Who the open thread belongs to, when this reader can be told.
   *
   * Reads the same cached history the timeline draws, so it costs no request.
   * `undefined` covers the honest gap: a thread whose head is older than the
   * page loaded, or an author who has since left the room. The banner then says
   * only that a thread is open — which is the part that must never be wrong,
   * because it is what stops the next sentence going somewhere unintended.
   */
  const entriesQuery = useRoomEntries(room.id);
  const replyingToName = useMemo(() => {
    if (replyTo === undefined) return undefined;
    const root = entriesQuery.data?.find((entry) => entry.id === replyTo);
    if (!root) return undefined;
    return room.members.find((member) => member.author.id === root.authorId)?.author.displayName;
  }, [replyTo, entriesQuery.data, room.members]);

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
    //
    // The aim is read here rather than passed in, and it is deliberately NOT
    // cleared on success: an answer inside a thread is usually followed by
    // another one, and re-aiming between every sentence would make a thread the
    // most expensive place in the room to hold a conversation. The banner above
    // is what keeps that honest.
    if (replyTo !== undefined) {
      reply.mutate({ roomId: room.id, rootEntryId: replyTo, text: body });
      return;
    }
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
      {/*
        Where the next sentence is going, said plainly. It is a `status` so a
        screen reader is told when the aim changes rather than only on the way
        past it, and the way out is a real button — pressing it is how a reader
        who arrived here by keyboard gets back to addressing the room.
      */}
      {replyTo !== undefined && (
        <div
          role="status"
          data-testid="room-reply-banner"
          className="bg-muted/50 text-muted-foreground mb-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
        >
          <Reply aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {replyingToName === undefined
              ? 'Replying in a thread'
              : `Replying to ${replyingToName}`}
          </span>
          <button
            type="button"
            aria-label="Stop replying in this thread"
            onClick={() => useRoomReplyTargetStore.getState().clear(room.id)}
            className="focus-ring hover:text-foreground rounded p-0.5"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
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
        // The placeholder moves with the aim, so the box says where it is
        // pointed even for a reader who never looks up at the banner.
        placeholder={
          replyTo === undefined ? `Message ${roomDisplayTitle(room)}…` : 'Reply in this thread…'
        }
      />
    </div>
  );
}
