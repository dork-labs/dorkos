import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { Composer, type ComposerInputHandle } from '@/layers/features/composer';
import {
  JumpBackInPopover,
  isComposerField,
  useJumpBackInPopover,
} from '@/layers/features/jump-back-in';
import {
  MentionPalette,
  useMentionAutocomplete,
  type MentionRow,
} from '@/layers/features/mentions';
import { useInteractionStore } from '@/layers/entities/interactions';
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
import { useRoomAttachments } from '../model/use-room-attachments';

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
  /**
   * Float "Jump back in" over this composer while its box is still empty.
   *
   * The home surface's composer, and only it (team-room-home spec D2.3): the
   * panel answers "you have just arrived — where were you?", which is a
   * question the page you land on asks and a room you deliberately opened does
   * not. It yields to the `@` picker rather than stacking a second listbox over
   * the same field; `useJumpBackInPopover`'s `yieldToPalette` owns that rule.
   */
  offerJumpBackIn?: boolean;
  /**
   * Tell the host when the caret enters and leaves this composer's text field.
   *
   * Only the FIELD counts — reaching for Send or the paperclip is not "typing"
   * — and only the room's own composer is wired to it, never the thread
   * panel's.
   *
   * The one host that listens is the home surface, and what it does with the
   * answer is give the composer the screen back: on a phone the pinned triage
   * header condenses to a one-line summary while the keyboard is up, because a
   * full header plus a keyboard leaves the box you are typing in behind the
   * keyboard (measured at 375×812 in spec task 2.7's browser gate).
   */
  onFocusChange?: (focused: boolean) => void;
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
 *
 * One host-chosen extra: `offerJumpBackIn` floats the last few threads you were
 * in over the box while it is still empty. The home surface asks for it and
 * nothing else does — see the prop.
 */
export function RoomComposer({
  room,
  threadRootId,
  focusOnMount,
  offerJumpBackIn,
  onFocusChange,
}: RoomComposerProps) {
  // The one key that decides everything about this composer: which draft it
  // holds, which caret requests are its own, and where refused words go back.
  const draftKey = threadRootId === undefined ? room.id : threadDraftKey(room.id, threadRootId);
  const text = useRoomDraft(draftKey);
  const post = usePostToRoom();
  const reply = useReplyInThread();
  const focusRequest = useComposerFocusRequest(draftKey);
  const inputRef = useRef<ComposerInputHandle>(null);
  /**
   * Whether a send is currently waiting for its files to reach the server.
   *
   * A ref rather than state on purpose: it is read and written inside one
   * keystroke's synchronous path, and a re-render between the two would be
   * exactly the stale-closure window it exists to close.
   */
  const uploading = useRef(false);
  // The chip bar. Keyed to nothing: this composer's files are this composer's,
  // because the state is its own — see `useRoomAttachments`. None of it reaches
  // `Composer.Input`, which holds no attachment state at all, so DOR-948's swap
  // of that component's internals for Lexical stays a swap.
  const attachments = useRoomAttachments(room.id);

  const mentions = useMentionAutocomplete({
    members: room.members,
    viewerAuthorId: room.viewerAuthorId,
    text,
  });

  /**
   * The recents panel, which can only ever open where it was offered.
   *
   * The hook runs on every room composer — it has to, they are hooks — but
   * `enabled` decides whether it does anything at all, and it must: this
   * component is mounted in every room and in every thread panel, and only the
   * home surface offers the panel. Left on, each of those instances subscribed
   * to the recents fan-out, the room list, the fleet and its manifests, and
   * re-read them on every session lifecycle event, for a panel no gesture in
   * that room could raise. Off, every one of those queries stays idle.
   *
   * It yields to the `@` picker, which is the one that must win: two listboxes
   * claiming the same arrow keys over the same field is a fight the reader
   * loses.
   */
  const offersRecents = offerJumpBackIn === true;
  const jumpBackIn = useJumpBackInPopover({
    value: text,
    yieldToPalette: mentions.isOpen,
    enabled: offersRecents,
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

  /**
   * Finish a send whose files still have to reach the server.
   *
   * Split from `handleSubmit` so everything that must happen AT the keystroke —
   * emptying the box, minting the id, reading the names — stays synchronous.
   * Only the wait for the bytes is asynchronous, and it happens after the box is
   * already free for the next sentence.
   */
  const deliver = async (
    body: string,
    clientId: string,
    attachmentNames: string[],
    sentFileIds: string[]
  ) => {
    let attachmentIds: string[];
    // Only a send that actually carries files can be re-entered destructively,
    // and only that kind arms the guard: two text-only messages in one tick are
    // ordinary and must both go.
    const carriesFiles = attachmentNames.length > 0;
    if (carriesFiles) uploading.current = true;
    try {
      attachmentIds = await attachments.uploadAndGetIds();
    } catch {
      // The post was never made, so there is no pending row holding these words
      // — the box is the only place they can survive, and it is the box they
      // were typed in. Restored only while it is still empty: merging them into
      // a sentence typed since is the exact failure DOR-783 removed from the
      // refusal path, and one sentence lost to a sub-second race is better than
      // two sentences with a claim on one field. The chips stay, in error, with
      // their reason on the bar and in the composer's own refusal line.
      const store = useRoomDraftStore.getState();
      if ((store.drafts[draftKey] ?? '') === '') store.set(draftKey, body);
      return;
    } finally {
      // Released whichever way it went, so a failed upload does not wedge the
      // composer shut.
      if (carriesFiles) uploading.current = false;
    }
    // Cleared only once the ids are safely in the message: a chip removed before
    // that would take a file out of a send that had not gone yet. Scoped to the
    // batch this send took, so a file dropped in DURING the upload survives —
    // clearing the bar wholesale silently ate it.
    attachments.clearFiles(sentFileIds);
    // No per-call callbacks: a refusal is handled by the mutation itself, which
    // still runs when this composer is gone. See `usePostToRoom`.
    if (threadRootId !== undefined) {
      reply.mutate({
        roomId: room.id,
        rootEntryId: threadRootId,
        text: body,
        clientId,
        attachmentIds,
        attachmentNames,
      });
      return;
    }
    post.mutate({ roomId: room.id, text: body, clientId, attachmentIds, attachmentNames });
  };

  const handleSubmit = () => {
    if (room.archived) return;
    // **One send at a time while files are still going up.** `pendingFiles` is
    // cleared only once the ids are safely in a message, so a second Enter
    // arriving during that await would read the SAME files and upload them
    // again — posting duplicates, or taking a 409 for ids the first send had
    // already claimed. The draft is deliberately NOT taken here: refusing early
    // leaves the sentence in the box, where the person can send it a moment
    // later, rather than consuming it into a message that cannot be written.
    //
    // Text-only sends never arm this, so two sentences in one tick still both
    // go — that is the behaviour DOR-783 asked for and it is unchanged.
    if (uploading.current) return;
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
    // **Posting into a room is an interaction with it** (DOR-1156). Today is
    // ordered by `max(userLastMessageAt, userLastOpenedAt)` (BC-16) and the
    // client half was only written by opening a row — so the home surface,
    // which IS #team and is arrived at rather than opened, could be written in
    // all morning and still hold no record at all.
    //
    // Recorded here rather than in `usePostToRoom`, and not only because an
    // entity may not import a sibling entity: this is the keystroke, and the
    // post is still one upload away from being made. A thread reply records the
    // ROOM, matching `SidebarChrome.openTarget` — a thread reads its room's
    // cursor, so one place has one record.
    useInteractionStore.getState().recordOpened('room', room.id);
    // The id is minted here, at the keystroke, because that is when the row has
    // to appear — before there is any server id to call it by.
    const clientId = newPendingId();
    // The names are read here for the same reason: the pending row has to show
    // the files from the keystroke, and an upload still in flight has no ids to
    // draw them from yet.
    const attachmentNames = attachments.pendingFiles.map((f) => f.file.name);
    // The batch identity, read in the same breath as the names: what this send
    // is sending, and therefore exactly what it may clear when it lands.
    const sentFileIds = attachments.pendingFiles.map((f) => f.id);
    void deliver(body, clientId, attachmentNames, sentFileIds);
  };

  const card = (
    // Passing `onFilesDropped` is the whole attach declaration: it is what
    // mounts the dropzone, the hidden file input and the "Drop files to attach"
    // overlay. There is no flag to set — see `features/composer`'s doctrine.
    <Composer.Root onFilesDropped={attachments.addFiles}>
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
      <Composer.OverlayLane>
        <AnimatePresence>
          {mentions.isOpen && (
            <MentionPalette
              rows={mentions.rows}
              selectedIndex={mentions.selectedIndex}
              onSelect={takeRow}
            />
          )}
        </AnimatePresence>
        {/* Never up at the same time as the picker above it: the recents panel
            yields to `@`, and typing at all takes it down. */}
        {jumpBackIn.isOpen && (
          <JumpBackInPopover
            rows={jumpBackIn.rows}
            selectedIndex={jumpBackIn.selectedIndex}
            agents={jumpBackIn.agents}
            displayNames={jumpBackIn.displayNames}
            visualOf={jumpBackIn.visualOf}
            onSelect={jumpBackIn.selectRow}
          />
        )}
        {/* Above the box, in the lane the picker uses, for the reason
            `ClearArmedHint` sets out: anchored to the field it lands on top of
            whatever is stacked over the composer. */}
        {clearArmed && <Composer.ClearArmedHint />}
      </Composer.OverlayLane>
      {/* Between the lane and the box, which is where chat puts it, so a file
          waiting to be sent sits in the same place on every surface. */}
      {attachments.pendingFiles.length > 0 && (
        <Composer.Attachments
          files={attachments.pendingFiles}
          onRemove={attachments.removeFile}
          onRetry={attachments.retryFile}
          onCancel={attachments.cancelUpload}
        />
      )}
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
        // One field, one keyboard, and whichever panel is up owns it. The two
        // cannot both be open — the recents panel yields to `@` and closes on
        // the first keystroke — so this is a dispatch, not an arbitration.
        isPaletteOpen={mentions.isOpen || jumpBackIn.isOpen}
        paletteHasResults={jumpBackIn.isOpen ? jumpBackIn.hasRows : mentions.hasSelectableRows}
        onArrowUp={jumpBackIn.isOpen ? jumpBackIn.moveUp : mentions.moveUp}
        onArrowDown={jumpBackIn.isOpen ? jumpBackIn.moveDown : mentions.moveDown}
        onCommandSelect={jumpBackIn.isOpen ? jumpBackIn.selectHighlighted : takeHighlighted}
        onEscape={jumpBackIn.isOpen ? jumpBackIn.dismiss : mentions.dismiss}
        // Tab picks a row of a palette you ASKED for by typing `@`, and does
        // not pick one from a panel that floated up because the caret landed in
        // an empty box — there, tabbing on has to move focus.
        tabPicks={!jumpBackIn.isOpen}
        // Wiring this is what puts a labelled "Clear message" button on the
        // composer — and `Composer.Input` refuses to raise the armed readout at all
        // without one, because a destructive shortcut that only sighted people
        // are told about is worse than no shortcut.
        onClear={() => {
          setDraft('');
          mentions.dismiss();
        }}
        onClearArmedChange={setClearArmed}
        activeDescendantId={
          jumpBackIn.isOpen ? jumpBackIn.activeDescendantId : mentions.activeDescendantId
        }
        paletteListboxId={jumpBackIn.isOpen ? jumpBackIn.listboxId : mentions.listboxId}
        // Deliberately NOT gated on a post being in flight. Sending is a
        // fire-and-forget 202, and closing the submit path for its duration
        // would block the second sentence of anyone who types faster than the
        // network — silently, since a refused submit says nothing.
        canSubmit={!room.archived && !attachments.hasFailedUpload}
        canSubmitReason={
          room.archived
            ? 'This conversation is archived. You can read it, but not add to it.'
            : attachments.hasFailedUpload
              ? 'A file didn’t upload. Try it again or remove it, then send.'
              : undefined
        }
        // The paperclip. Same handler as the dropzone, so clicking, dragging and
        // pasting a file all land in the same bar.
        onAttach={attachments.addFiles}
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
    </Composer.Root>
  );

  // Nothing to host: the card is the composer, node for node, exactly as it
  // ships in every room. The wrapper below is not free — it is a second element
  // in the DOM parity baseline this composer is held to — so it exists only
  // where something actually listens.
  if (!offersRecents && onFocusChange === undefined) return card;

  return (
    // Focus and pointer-down are both watched, and both are needed: the
    // composer can already hold the caret when a person clicks it, which
    // dispatches no focus event at all, so the click would otherwise do
    // nothing. The handlers ignore anything that is not the text field, so
    // reaching for Send or the paperclip never floats a panel up.
    //
    // The rule below is about elements that BEHAVE interactively without saying
    // so. This one takes no focus and offers no action; it only overhears
    // events from a control inside it that is already a real, keyboard-reachable
    // combobox announcing the panel through `aria-expanded` and
    // `aria-activedescendant`. A role or a tab stop here would add a focus stop
    // that does nothing, which is the defect the rule exists to prevent.
    //
    // `flex flex-col` so the card stays a flex item exactly as it was before
    // the wrapper: as a block child its margins would collapse through this
    // element instead of spacing it.
    //
    // The anchor rides the flag, and that coupling is deliberate but narrow:
    // `offerJumpBackIn` means "the home surface's composer" today, so this is
    // the element the general tour spotlights and the browser specs address.
    // The day a SECOND surface wants the recents panel, two elements would
    // carry `home-composer` and both the tour and the page objects would go
    // ambiguous — at that point the anchor needs its own prop rather than a
    // ride on this one. `tour-anchors.test.tsx` mounts the real home page, so
    // an anchor that stops being stamped here fails there.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- container overhears its combobox's focus; see above
    <section
      className="flex flex-col"
      // Stamped for either reason this wrapper exists, because both props say
      // the same thing today: `offerJumpBackIn` and `onFocusChange` are set by
      // one host, the home surface, and by the same call. The day either one is
      // wanted somewhere else, the anchor needs the prop of its own the note
      // above already describes — and it is a literal here on purpose, because
      // `tour-anchors.test.tsx` reads this line as source.
      data-testid={TOUR_ANCHORS.homeComposer}
      onFocus={(event) => {
        jumpBackIn.handleFocus(event);
        if (isComposerField(event.target)) onFocusChange?.(true);
      }}
      onBlur={(event) => {
        jumpBackIn.handleBlur(event);
        if (isComposerField(event.target)) onFocusChange?.(false);
      }}
      onPointerDown={jumpBackIn.handlePointerDown}
    >
      {card}
    </section>
  );
}
