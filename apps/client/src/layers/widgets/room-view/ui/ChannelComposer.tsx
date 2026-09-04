/**
 * Say something in a room — the room's wiring for `Conversation.Composer`.
 *
 * What is left of the retired `RoomComposer` once the card itself is shared:
 * which palettes this surface opens, what Enter means to it, where its draft
 * lives, and who is allowed to write here. The card's SHAPE — the overlay lane,
 * the chip bar, the field, the honest disabled state — is
 * `Conversation.Composer`, and a session's composer is the same code.
 *
 * @module widgets/room-view/ui/ChannelComposer
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { Button } from '@/layers/shared/ui';
import type { ComposerInputHandle } from '@/layers/features/composer';
import { Conversation, useConversation } from '@/layers/features/conversation';
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
import {
  JOIN_ROOM_VERB,
  NOT_IN_ROOM_SENTENCE,
  isRoomMember,
  roomDisplayTitle,
  threadDraftKey,
  useAddRoomMember,
  useComposerFocusRequest,
  useRoomDraft,
  useRoomDraftStore,
  type RoomWithRoster,
} from '@/layers/entities/room';
import type { useRoomAttachments } from '../model/use-room-attachments';

interface ChannelComposerProps {
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
  /**
   * The staged files, as the host's own `useRoomTarget` holds them.
   *
   * Passed in rather than read here because the TARGET already holds it — the
   * send has to upload and clear the same batch it took — and two calls to
   * `useRoomAttachments` would be two independent chip bars for one box.
   */
  attachments: ReturnType<typeof useRoomAttachments>;
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
export function ChannelComposer({
  room,
  threadRootId,
  focusOnMount,
  offerJumpBackIn,
  onFocusChange,
  attachments,
}: ChannelComposerProps) {
  // The one key that decides everything about this composer: which draft it
  // holds, which caret requests are its own, and where refused words go back.
  const draftKey = threadRootId === undefined ? room.id : threadDraftKey(room.id, threadRootId);
  const text = useRoomDraft(draftKey);
  // Where this box's words go. `Conversation.Composer` is what refuses loudly
  // when a host forgot to publish one; here it is only read, so the send simply
  // has nothing to call.
  const { target } = useConversation();
  const join = useAddRoomMember();
  const focusRequest = useComposerFocusRequest(draftKey);
  const inputRef = useRef<ComposerInputHandle>(null);
  /**
   * Whether the viewer is still on this room's roster.
   *
   * A room the operator sees but is not a member of is real and reachable —
   * she left it, or an agent opened it without her (DOR-1233, DOR-1611) — and
   * posting into one is a definite server refusal (`MEMBER_NOT_FOUND`), never
   * a maybe. `RoomWithRoster` already carries both halves of this answer for
   * the CALLER actually looking at this screen (`viewerAuthorId` is resolved
   * per request, unlike the team roster's `isSelf`), so there is nothing to
   * fetch for it.
   */
  const isMember = isRoomMember(room.members, room.viewerAuthorId);
  /**
   * Whether a send is currently waiting for its files to reach the server.
   *
   * A ref rather than state on purpose: it is read and written inside one
   * keystroke's synchronous path, and a re-render between the two would be
   * exactly the stale-closure window it exists to close.
   */
  const uploading = useRef(false);

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
   * Send what is in the box.
   *
   * Everything that must happen AT the keystroke stays synchronous — the box is
   * emptied, the picker comes down, the words are read out of the STORE rather
   * than out of a render closure that is one render stale for a second Enter in
   * the same tick. Everything after that is the target's: it mints the pending
   * row's id, uploads the files, clears exactly the batch it took, and posts.
   */
  const handleSubmit = () => {
    if (target === null || !target.canSend) return;
    // **One send at a time while files are still going up.** Staged files are
    // cleared only once their ids are safely in a message, so a second Enter
    // arriving during that await would read the SAME files and upload them
    // again — posting duplicates, or taking a 409 for ids the first send had
    // already claimed. The draft is deliberately NOT taken here: refusing early
    // leaves the sentence in the box, where the person can send it a moment
    // later, rather than consuming it into a message that cannot be written.
    //
    // Text-only sends never arm this, so two sentences in one tick still both
    // go — that is the behaviour DOR-783 asked for, and it survives the move to
    // the shared composer because the FIELD's own "wait for the upload" rung is
    // handed only to a surface whose send waits for one
    // (`ConversationAttachmentPort.holdsSendWhileUploading`, false here).
    if (uploading.current) return;
    // Sending takes the picker down with it: Enter reaches this path only when
    // there was no row to pick, and nothing else would close a "No one by that
    // name." panel until the next keystroke.
    mentions.dismiss();
    const body = useRoomDraftStore.getState().take(draftKey).trim();
    if (body === '') return;
    // Only a send that actually carries files can be re-entered destructively,
    // and only that kind arms the guard: two text-only messages in one tick are
    // ordinary and must both go.
    const carriesFiles = attachments.pendingFiles.length > 0;
    if (carriesFiles) uploading.current = true;
    void target
      .send({ text: body })
      .catch(() => {
        // The post was never made, so there is no pending row holding these
        // words — the box is the only place they can survive, and it is the box
        // they were typed in. So they go back ALWAYS. The earlier rule put them
        // back only into an empty box, which meant a person who kept typing
        // while the send failed lost the first sentence outright, with nothing
        // on screen to say so.
        //
        // When something has been typed since, the failed words go ABOVE it
        // rather than over it: DOR-783's lesson was that a refusal must not
        // overwrite a sentence in progress, and this does not — both are in the
        // box, in the order they were typed, and either can be deleted. The
        // chips stay, in error, with their reason on the bar and in the
        // composer's own refusal line.
        const store = useRoomDraftStore.getState();
        const since = store.drafts[draftKey] ?? '';
        store.set(draftKey, since === '' ? body : `${body}\n${since}`);
      })
      .finally(() => {
        // Released whichever way it went, so a failed upload does not wedge the
        // composer shut.
        if (carriesFiles) uploading.current = false;
      });
  };

  // Checked before the composer is built at all, not passed down as a reason
  // string the way `archived` is: `canSubmitReason` is one line of text next
  // to a field that still LOOKS live, and a field a definite server refusal
  // is waiting behind should not look live. This replaces it outright, the
  // same way the archived room's own history stays readable while nothing
  // here pretends you can add to it.
  if (!isMember) {
    return (
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
        <p className="text-muted-foreground text-sm">{NOT_IN_ROOM_SENTENCE}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={join.isPending}
          onClick={() =>
            join.mutate(
              { roomId: room.id, authorId: room.viewerAuthorId },
              { onSuccess: () => toast.success(`You joined ${roomDisplayTitle(room)}`) }
            )
          }
        >
          {JOIN_ROOM_VERB}
        </Button>
      </div>
    );
  }

  const card = (
    <Conversation.Composer
      inputRef={inputRef}
      value={text}
      onChange={(next) => {
        setDraft(next);
        // Records the text only. `onCursorChange` fires immediately after with
        // the REAL caret, and that is what runs trigger detection — guessing
        // the caret here is wrong for any edit not at the end.
        mentions.noteTextChange(next);
      }}
      onSubmit={handleSubmit}
      head={
        /* Mounted whether or not the picker is open, and empty until it has
           something to say. The picker itself cannot carry this: it arrives with
           its "No one by that name." already in it, which is the classic case
           assistive technology does not announce — the region has to be watched
           BEFORE the words land in it. Same shape as `Conversation.LiveLane`'s
           announcer, and the same reason.

           Only the empty answer is spoken. A picker with rows in it already
           reports itself: the composer publishes the highlighted row as its
           `aria-activedescendant`, so a screen reader reads that row on every
           keystroke. Silence was only ever the answer for the one case where
           there is no row to read. */
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {mentions.isOpen && mentions.rows.length === 0 ? 'No one by that name.' : ''}
        </span>
      }
      mentionPicker={
        <AnimatePresence>
          {mentions.isOpen && (
            <MentionPalette
              rows={mentions.rows}
              selectedIndex={mentions.selectedIndex}
              onSelect={takeRow}
            />
          )}
        </AnimatePresence>
      }
      overlays={
        <>
          {/* Never up at the same time as the `@` picker above it: the recents panel
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
        </>
      }
      input={{
        onCursorChange: mentions.handleCursorChange,
        isStreaming: false,
        // One field, one keyboard, and whichever panel is up owns it. The two
        // cannot both be open — the recents panel yields to `@` and closes on
        // the first keystroke — so this is a dispatch, not an arbitration.
        isPaletteOpen: mentions.isOpen || jumpBackIn.isOpen,
        paletteHasResults: jumpBackIn.isOpen ? jumpBackIn.hasRows : mentions.hasSelectableRows,
        onArrowUp: jumpBackIn.isOpen ? jumpBackIn.moveUp : mentions.moveUp,
        onArrowDown: jumpBackIn.isOpen ? jumpBackIn.moveDown : mentions.moveDown,
        onCommandSelect: jumpBackIn.isOpen ? jumpBackIn.selectHighlighted : takeHighlighted,
        onEscape: jumpBackIn.isOpen ? jumpBackIn.dismiss : mentions.dismiss,
        // Tab picks a row of a palette you ASKED for by typing `@`, and does not
        // pick one from a panel that floated up because the caret landed in an
        // empty box — there, tabbing on has to move focus.
        tabPicks: !jumpBackIn.isOpen,
        // Wiring this is what puts a labelled "Clear message" button on the
        // composer — and `Composer.Input` refuses to raise the armed readout at
        // all without one, because a destructive shortcut that only sighted
        // people are told about is worse than no shortcut.
        onClear: () => {
          setDraft('');
          mentions.dismiss();
        },
        activeDescendantId: jumpBackIn.isOpen
          ? jumpBackIn.activeDescendantId
          : mentions.activeDescendantId,
        paletteListboxId: jumpBackIn.isOpen ? jumpBackIn.listboxId : mentions.listboxId,
        // Ties the pending double-Escape wipe to this room, so an arm raised in
        // one conversation cannot clear the draft of the next one.
        contextKey: draftKey,
        // A room says why a failed attachment closed its send, in a line beside
        // the box; a session answers the same state with the red chip above it.
        // Each surface keeps its own answer, which is why the reason comes from
        // here rather than from the shared card.
        ...(attachments.hasFailedUpload
          ? { canSubmitReason: 'A file didn’t upload. Try it again or remove it, then send.' }
          : {}),
      }}
    />
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
