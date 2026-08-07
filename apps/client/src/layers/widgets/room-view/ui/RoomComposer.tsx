import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Composer, type ComposerInputHandle } from '@/layers/features/composer';
import {
  MentionPalette,
  useMentionAutocomplete,
  type MentionRow,
} from '@/layers/features/mentions';
import {
  newPendingId,
  roomDisplayTitle,
  threadDraftKey,
  useComposerFocusRequest,
  useRoomDraft,
  useRoomDraftStore,
  usePostToRoom,
  useReplyInThread,
  type RoomWithRoster,
} from '@/layers/entities/room';

interface RoomComposerProps {
  /** The room on screen. Its archived flag decides whether posting is offered. */
  room: RoomWithRoster;
  /**
   * The thread this composer writes into, when it is a thread panel's rather
   * than the room's own. Absent for the room's composer.
   */
  threadRootId?: string;
  /**
   * Take the caret as soon as this composer exists.
   *
   * For the one case the focus store cannot serve: "Reply in thread" MOUNTS
   * this composer, so the request and the mount are the same event and there is
   * no change for the effect below to notice. `focusUnlessTouch`, so a phone
   * opens a thread rather than a keyboard over one.
   */
  focusOnMount?: boolean;
}

/**
 * Say something in a room.
 *
 * The same composer session chat uses, so Enter, Shift+Enter and the send
 * button all mean here what they mean there — and so a room does not acquire a
 * second, subtly different text box.
 *
 * The message round-trips: the room's own copy arrives on its stream, which is
 * also the only way a second reader — or the agents the post triggers — would
 * ever see it. The box empties the moment you press Enter, the way session
 * chat's does, so the next sentence can be typed while the first is still in the
 * air — and the words go to a pending row at the tail of the conversation
 * (`pending-posts`) rather than nowhere, so a slow link no longer looks like a
 * message that was never typed.
 *
 * This component holds no draft of its own. The text belongs to the ROOM
 * (`useRoomDraft`), which is what lets it survive being navigated away from.
 *
 * Typing `@` opens the mention picker over this room's roster. It writes the
 * handle the SERVER resolves rather than the name on screen, which is what
 * turns "did that reach anyone?" into something you can see before you send.
 * The composer stays the shared `Composer.Input` — it already carries every palette
 * prop; only the panel above it is new.
 *
 * **One component, two destinations — decided by where it is MOUNTED, not by a
 * mode it is put into.** The room's composer writes into the room; the thread
 * panel's writes into that thread. There is no aim to set, no banner saying
 * where the next sentence is going, and no way for a box to be pointed
 * somewhere the reader did not look, because the box you are typing in is
 * physically inside the conversation it posts to.
 *
 * That replaced a genuinely awkward shape (design record §3): one composer that
 * "Reply in thread" silently re-aimed, with a banner above it as the only thing
 * standing between the reader and a thread reply becoming a room-wide post. The
 * banner worked, but it was a label compensating for a layout that lied. A
 * thread now has somewhere to be, so the composer can simply be there.
 *
 * Its draft is keyed the same way — the room id, or `threadDraftKey` — so the
 * two boxes never share text, and each survives being closed and reopened.
 */
export function RoomComposer({ room, threadRootId, focusOnMount }: RoomComposerProps) {
  // The one key that decides everything about this composer: which draft it
  // holds, which caret requests are its own, and where refused words go back.
  const draftKey = threadRootId === undefined ? room.id : threadDraftKey(room.id, threadRootId);
  const text = useRoomDraft(draftKey);
  const post = usePostToRoom();
  const reply = useReplyInThread();
  const focusRequest = useComposerFocusRequest(draftKey);
  const inputRef = useRef<ComposerInputHandle>(null);

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

  // Run once, on mount, and never again — the prop describes how this composer
  // came into existence, which cannot happen twice to one instance.
  useEffect(() => {
    if (focusOnMount === true) inputRef.current?.focusUnlessTouch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; see above
  }, []);

  const setDraft = useCallback(
    (next: string) => useRoomDraftStore.getState().set(draftKey, next),
    [draftKey]
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

  /**
   * Whether a second Escape would wipe what is in the box.
   *
   * The wipe is `Composer.Input`'s and has always worked here; what was missing is
   * the half that makes it a shortcut rather than a trap. A reader with a draft
   * in a thread pressed Escape expecting the panel to close — the panel stays,
   * deliberately, because a keystroke aimed at a draft must not also throw away
   * the place it was being written — and nothing on screen said what the press
   * had done or what the next one would do. Two taps later the draft was gone.
   *
   * The same readout session chat draws, in the same lane above the box, from
   * the same state inside the same component. `Composer.Input` folds in whether the
   * labelled Clear button is reachable before raising this, which is why the
   * button below is wired at all: the hint is hidden from assistive tech, so
   * without a labelled equivalent it would hand sighted people a destructive
   * shortcut and nobody else.
   */
  const [clearArmed, setClearArmed] = useState(false);

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
    const body = useRoomDraftStore.getState().take(draftKey).trim();
    if (body === '') return;
    // No per-call callbacks: a refusal is handled by the mutation itself, which
    // still runs when this composer is gone. See `usePostToRoom`.
    //
    // The id is minted here, at the keystroke, because that is when the row has
    // to appear — before there is any server id to call it by.
    const clientId = newPendingId();
    if (threadRootId !== undefined) {
      reply.mutate({ roomId: room.id, rootEntryId: threadRootId, text: body, clientId });
      return;
    }
    post.mutate({ roomId: room.id, text: body, clientId });
  };

  return (
    <div className="relative border-t p-3">
      {/* Mounted whether or not the picker is open, and empty until it has
          something to say. The picker itself cannot carry this: it arrives with
          its "No one by that name." already in it, which is the classic case
          assistive technology does not announce — the region has to be watched
          BEFORE the words land in it. Same shape as `RoomPresenceLine`'s
          announcer, and the same reason.

          Only the empty answer is spoken. A picker with rows in it already
          reports itself: the composer publishes the highlighted row as its
          `aria-activedescendant`, so a screen reader reads that row on every
          keystroke. Silence was only ever the answer for the one case where
          there is no row to read. */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {mentions.isOpen && mentions.rows.length === 0 ? 'No one by that name.' : ''}
      </span>
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
        {/* Above the box, in the lane the picker uses, for the reason
            `ClearArmedHint` sets out: anchored to the field it lands on top of
            whatever is stacked over the composer. */}
        {clearArmed && <Composer.ClearArmedHint />}
      </div>
      <Composer.Input
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
        // Wiring this is what puts a labelled "Clear message" button on the
        // composer — and `Composer.Input` refuses to raise the armed readout at all
        // without one, because a destructive shortcut that only sighted people
        // are told about is worse than no shortcut.
        onClear={() => {
          setDraft('');
          mentions.dismiss();
        }}
        onClearArmedChange={setClearArmed}
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
        contextKey={draftKey}
        // The placeholder names the destination, which is also this composer's
        // accessible name — so "which conversation is this box for?" is a
        // question the accessibility tree can answer, not just a screenshot.
        placeholder={
          threadRootId === undefined
            ? `Message ${roomDisplayTitle(room)}…`
            : 'Reply in this thread…'
        }
      />
    </div>
  );
}
