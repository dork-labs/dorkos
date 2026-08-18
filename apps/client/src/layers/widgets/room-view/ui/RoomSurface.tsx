import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Skeleton } from '@/layers/shared/ui';
import { useIsMobile, useVisualViewportBottomInset } from '@/layers/shared/model';
import {
  useMarkRoomRead,
  useRoom,
  useRoomEntries,
  useRoomOpenThread,
  useRoomOpenThreadStore,
  useRoomStream,
  roomDisplayTitle,
  threadRootIdOf,
} from '@/layers/entities/room';
import type { ConversationTimelineHandle } from '@/layers/features/conversation';
import { RoomDetailsDialog, type RoomDetailsFocus } from '@/layers/features/room-management';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';
import { useRoomTarget } from '../model/room-target';
import { useFrozenReadCursor } from '../model/use-frozen-read-cursor';
import { useRestoreThreadFocus } from '../model/use-restore-thread-focus';
import { useThreadUrlSync, type ThreadRoute } from '../model/use-thread-url-sync';
import { ChannelComposer } from './ChannelComposer';
import { RoomFlow, RoomHistorySkeleton } from './RoomFlow';
import { RoomHeader } from './RoomHeader';
import { RoomLiveLane } from './RoomLiveLane';
import { RoomThreadPanel } from './RoomThreadPanel';

/** What {@link RoomSurface} needs to draw a room. */
export interface RoomSurfaceProps {
  /** The room to render. */
  roomId: string;
  /** `?thread=` as it arrived on this route, when there is one. */
  threadId?: string;
  /** Which address the open thread is mirrored into. */
  threadRoute: ThreadRoute;
  /**
   * Chrome this host puts between the room's masthead and its feed.
   *
   * **Outside the scroller, deliberately.** The home surface's pinned triage
   * header changes height as approvals are answered, and a height change INSIDE
   * the scrolling element moves `scrollHeight` under `useTimelineScroll` — which
   * reads the distance from the bottom to decide whether the reader is still
   * following the room. A header that grows inside it therefore un-pins a
   * reader who never scrolled. Here it is a flex sibling: it takes its own
   * space, the feed keeps its own scroll, and the two never argue.
   */
  aboveTimeline?: ReactNode;
  /**
   * Chrome this host puts between the feed and the composer.
   *
   * The other end of {@link RoomSurfaceProps.aboveTimeline}, for things that
   * belong to the BOX rather than to the room: the home surface's day-one
   * starter chips, which are lines waiting to be typed and would mean nothing
   * floating above a feed. Outside the scroller for the same reason as the other
   * slot — it takes its own space and leaves the feed's scroll alone.
   *
   * It sits above the stalled notice, which keeps its place directly over the
   * composer: a warning about what happens when you press Enter has to be the
   * last thing between you and Enter.
   */
  aboveComposer?: ReactNode;
  /**
   * Float "Jump back in" over this room's composer while the box is empty.
   *
   * Opt-in, and on for the home surface only (spec D2.3): the panel is an
   * answer to "you have just arrived, where were you?", which is a question
   * only the page you land on is asking.
   */
  offerJumpBackIn?: boolean;
  /**
   * Told when the caret enters and leaves the ROOM composer's text field.
   *
   * A pass-through to `ChannelComposer.onFocusChange`, and deliberately nothing
   * more: this component does not act on it. It exists because the two things
   * that have to agree — the composer down here and a host's chrome up in
   * {@link RoomSurfaceProps.aboveTimeline} — are siblings with no way to reach
   * each other, so the state is lifted to whoever composes them. The home
   * surface uses it to condense its pinned header while a phone keyboard is up.
   *
   * The thread panel's composer is NOT wired to it. A reply is typed into the
   * panel, which covers the chrome anyway.
   */
  onComposerFocusChange?: (focused: boolean) => void;
}

/**
 * One room, whole: masthead, feed, composer, presence line and thread panel.
 *
 * The room machinery every surface that shows a room renders — `/channels`
 * addresses one by search param, and the home tab renders #team through this
 * same component (team-room-home spec D3.2). There is no second room widget and
 * no home-specific copy of one: what a host contributes is an address, chrome
 * above the feed, and nothing else.
 *
 * `?thread=` is still a relation between entries in this room's log rather than
 * a room of its own (ADR 260728-022013) — the panel is a place to READ one, not
 * a second kind of room, and it never changes which room is on screen.
 *
 * **Two shapes, one panel.** On a wide screen the thread is a column beside the
 * room. On a phone it is a full-screen push with a Back button, following the
 * drill-in this app already uses for master/detail (`navigation-layout.tsx`) —
 * a real push rather than a sheet over the top, because the design asks for the
 * thread to BE the screen and a drawer covering a room you cannot use is a
 * worse version of the same thing.
 *
 * @param props - The room, its thread address, and the host's chrome.
 */
export function RoomSurface({
  roomId,
  threadId,
  threadRoute,
  aboveTimeline,
  aboveComposer,
  offerJumpBackIn,
  onComposerFocusChange,
}: RoomSurfaceProps) {
  const isMobile = useIsMobile();
  // How much of the screen a software keyboard is currently eating. `0`
  // everywhere else, including every desktop — see the mobile branch below.
  const keyboardInset = useVisualViewportBottomInset();
  const openThread = useRoomOpenThread(roomId);
  const openThreadId = openThread?.rootEntryId;
  // Where the caret goes once the panel has gone — `useRestoreThreadFocus`
  // owns the three ways that lookup used to miss.
  const restoreFocus = useRestoreThreadFocus();

  const closeThread = useCallback(() => {
    const rootId = useRoomOpenThreadStore.getState().open[roomId]?.rootEntryId;
    useRoomOpenThreadStore.getState().closeThread(roomId);
    if (rootId !== undefined) restoreFocus.arm(rootId);
  }, [roomId, restoreFocus]);
  // From a reply row: a request to READ, so the panel takes focus and the
  // keyboard stays shut. The capsule's reply action asks for the composer.
  const onOpenThread = useCallback(
    (rootEntryId: string) => {
      useRoomOpenThreadStore.getState().openThread(roomId, rootEntryId);
    },
    [roomId]
  );

  const roomQuery = useRoom(roomId);
  const entriesQuery = useRoomEntries(roomId);
  const stream = useRoomStream(roomId, entriesQuery.isSuccess);
  // Two of spec §14.3's three entry points are on this surface — the header's
  // roster and the empty state — and both open the one panel the sidebar's row
  // menu opens. The panel reads its own fleet, which is what lets this page
  // open it without holding one; the sidebar may be a closed drawer here.
  const [detailsFocus, setDetailsFocus] = useState<RoomDetailsFocus | null>(null);

  const room = roomQuery.data;
  const entries = useMemo(() => entriesQuery.data ?? [], [entriesQuery.data]);
  // Where this room's words go, and the chip bar the send shares with the
  // composer. Built here rather than inside the composer so the whole
  // conversation can publish it — the lane reads the target's id, and the
  // thread panel builds its own.
  const roomTarget = useRoomTarget({ room });

  // Placed after the history, because it needs it: a link naming a reply is
  // resolved to that reply's thread, and only the loaded entries can say which
  // thread that is.
  useThreadUrlSync({
    roomId,
    route: threadRoute,
    urlThreadId: threadId,
    openThreadId,
    entries,
    historyLoaded: entriesQuery.isSuccess,
  });

  // `viewerAuthorId` is the server's own answer to "which of these members am
  // I", resolved on the request that returned this room. Matching on it rather
  // than on `kind === 'human'` is what makes the unread rule this reader's own:
  // with two people in a room the old lookup returned whichever sorted first, so
  // one person's divider tracked the other's cursor. `null` (not a member)
  // draws no rule at all.
  const lastReadSeq = useMemo(
    () =>
      room?.members.find((member) => member.author.id === room.viewerAuthorId)?.lastReadSeq ?? null,
    [room]
  );

  // Reading a room is what marks it read. The rule renders from the cursor as it
  // stood when the room opened, then the real cursor catches up — so you still
  // see where you left off, and the sidebar badge does not sit there claiming
  // you have not.
  //
  // `entries` reaches BOTH of these whole, and that is the invariant: the
  // timeline leaves thread replies out of the flow it draws, but the cursor is
  // moved to the room's true newest `seq` (`groupByThread` explains why any
  // earlier filter breaks the badge, and what it costs to do it this way).
  const frozenReadSeq = useFrozenReadCursor(roomId, lastReadSeq);
  useMarkRoomRead(room, entries);

  // The timeline's own handle, so the lane's peek can take a reader to a row —
  // including one virtualization has left out of the document.
  const timelineRef = useRef<ConversationTimelineHandle>(null);
  /**
   * The row the reader was on, held HERE because this component is what
   * survives a thread.
   *
   * On a phone the thread panel is a full-screen push: it unmounts the room
   * column, timeline and all, and coming back mounts a brand new one at the
   * top. Measured on a 390x844 viewport: 1148px before opening a thread, 0px
   * after closing it — the room silently jumped to its oldest message. The
   * timeline cannot remember this for itself, and neither can a module-level
   * map: the answer has to be a ROW rather than an offset (the virtualizer's
   * total height is an estimate until it settles), and it has to be forgotten
   * when the reader switches rooms — both of which are facts this component
   * holds and that one does not.
   *
   * A ref rather than state: it is written on every scroll, and re-rendering
   * the room under the reader's finger to store it would be the cost the
   * virtualizer was added to avoid.
   */
  const resumeRowRef = useRef<string | undefined>(undefined);
  const noteTopRow = useCallback((rowId: string | undefined) => {
    resumeRowRef.current = rowId;
  }, []);
  const resumeRow = useCallback(() => resumeRowRef.current, []);
  // A room you SWITCHED to opens at its newest message, the way every chat
  // surface does — only a return to the same room is a return.
  useEffect(() => {
    resumeRowRef.current = undefined;
  }, [roomId]);
  const scrollToRow = useCallback((domId: string) => {
    timelineRef.current?.scrollToRow(domId);
  }, []);

  // The open thread's replies, so the room's presence line can hand exactly
  // those claims to the panel and keep the rest. `undefined` — no thread open —
  // means the room's line speaks for everything, which is the usual case.
  const threadScope = useMemo(() => {
    if (openThreadId === undefined) return undefined;
    const replyIds = new Set(
      entries.filter((entry) => threadRootIdOf(entry) === openThreadId).map((entry) => entry.id)
    );
    return { replyIds, inside: false };
  }, [entries, openThreadId]);

  if (roomQuery.isLoading) {
    return (
      <div className="flex h-full flex-col" aria-busy>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <RoomHistorySkeleton />
      </div>
    );
  }

  if (roomQuery.isError || !room) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm">
        <p className="text-foreground font-medium">That conversation isn&apos;t here</p>
        <p className="max-w-sm">
          It may have been archived, or the link may be out of date. Pick another one from the
          sidebar.
        </p>
      </div>
    );
  }

  const panel = openThread !== undefined && (
    <RoomThreadPanel
      // Keyed on the thread, so switching threads MOUNTS a new panel rather
      // than re-using the open one. Without it every per-thread one-shot in
      // there carries across: `useThreadArrivals` still holds the first
      // thread's seen-ids, so every reply of the second one is classified as a
      // fresh arrival and the whole thread bounces in at once, and the scroll
      // effect keys on `replies.length` — two threads with the same number of
      // replies would not even re-pin it.
      key={openThread.rootEntryId}
      room={room}
      rootEntryId={openThread.rootEntryId}
      focusComposer={openThread.focusComposer}
      entries={entries}
      reactionFrequents={room.reactionFrequents}
      streamStalled={stream.stalled}
      streamUnavailable={stream.unavailable}
      onRetryStream={stream.retry}
      historyLoaded={entriesQuery.isSuccess}
      historyFailed={entriesQuery.isError}
      pushed={isMobile}
      onClose={closeThread}
    />
  );

  const roomColumn = (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <RoomHeader room={room} onOpenMembers={() => setDetailsFocus('members')} />
      {/* The host's chrome, between the masthead and the scroller and inside
          neither — see `RoomSurfaceProps.aboveTimeline` for why that placement
          is the whole point. */}
      {aboveTimeline}
      <RoomFlow
        ref={timelineRef}
        roomId={room.id}
        roomName={roomDisplayTitle(room)}
        viewerAuthorId={room.viewerAuthorId}
        entries={entries}
        members={room.members}
        lastReadSeq={frozenReadSeq}
        reactionFrequents={room.reactionFrequents}
        streamStalled={stream.stalled}
        isLoading={entriesQuery.isLoading}
        error={entriesQuery.error}
        onAddAgents={() => setDetailsFocus('add')}
        openThreadId={openThreadId}
        onOpenThread={onOpenThread}
        resumeRow={resumeRow}
        onTopRow={noteTopRow}
      />
      {/* The host's chrome for the composer — see `RoomSurfaceProps.aboveComposer`. */}
      {aboveComposer}
      {/* The one reserved line, ABOVE the composer and outside the scroller.
          `specs/room-presence` §5.1 put the presence line underneath on purpose;
          that clause is superseded here (ADR 260818-002806) because the line now
          says everything that is happening rather than only who is working, and
          the thing you look at before pressing Enter belongs above the box you
          press it in. It is a fixed 24px, so an agent picking something up moves
          nothing that is already on screen — which is what the old placement was
          protecting against, and what a reserved height protects against better.

          Scoped to everything OUTSIDE the open thread, so an agent working on a
          thread reply is announced in the panel instead of here — one claim, one
          line, in the place the work is happening. */}
      <RoomLiveLane
        room={room}
        entries={entries}
        scope={threadScope}
        laneScope="room"
        stalled={stream.stalled}
        unavailable={stream.unavailable}
        onRetry={stream.retry}
        onScrollToRow={scrollToRow}
      />
      {/* Keyed on the room so opening a conversation gives you a composer that
          is focused and freshly sized for that room's draft. Switching to an
          already-read room takes none of the early returns above, so without
          this React reuses the instance and the input's own internals — focus,
          height, a part-typed IME composition — carry across. The DRAFT is safe
          either way; it belongs to the room, not to this element. */}
      <ChannelComposer
        key={room.id}
        room={room}
        attachments={roomTarget.attachments}
        offerJumpBackIn={offerJumpBackIn}
        onFocusChange={onComposerFocusChange}
      />

      {/* Mounted only while open: it reads the room itself, and a closed one
          would hold a roster from before the last change under it. */}
      {detailsFocus !== null && (
        <RoomDetailsDialog
          room={room}
          open
          onOpenChange={(next) => !next && setDetailsFocus(null)}
          focus={detailsFocus}
        />
      )}
    </div>
  );

  // What this conversation IS and what it can do, published once for every part
  // below — the row, the thread panel's rows, and (from P2) the live lane. A DM
  // is a room whose kind changes naming only, so `surface` tells them apart for
  // the one place that has to choose a word, and the capability table is shared.
  const conversation = {
    surface: room.kind === 'dm' ? ('dm' as const) : ('room' as const),
    capabilities: ROOM_CAPABILITIES,
    target: roomTarget.target,
    // A room's messages run long, so its action capsule rides a sticky rail
    // rather than being pinned to a corner that scrolls away.
    anchor: 'rail' as const,
  };

  // The phone's push: the thread REPLACES the room rather than covering it, and
  // slides in from the right the way this app's other drill-ins do. The room is
  // unmounted while it is open, which is the honest reading of a push — there
  // is one screen, and this is it.
  //
  // **One `AnimatePresence` spanning both states, not one inside the branch.**
  // An exit animation is played by the presence wrapper that OUTLIVES the thing
  // leaving; nested inside the `panel &&` branch it unmounted together with the
  // panel, so the push slid in and then simply blinked out. Room and panel are
  // siblings under one wrapper with stable keys, so `mode="wait"` gives the
  // real drill-in both ways.
  if (isMobile) {
    return (
      <Conversation.Root {...conversation}>
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={panel ? `thread-${openThreadId}` : 'room'}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
            // The room ends where the software keyboard begins.
            //
            // A phone's keyboard shrinks the VISUAL viewport and leaves the layout
            // viewport alone, so `h-dvh` on the shell above measures a screen that
            // is no longer all visible — and everything this column pins to its
            // bottom edge (the composer, the stalled notice, the presence line)
            // sits behind the keyboard the moment you tap to type. Insetting by
            // the difference is what puts them back above it, and it costs
            // nothing where there is no keyboard: the hook reads 0 without
            // `visualViewport`, under pinch-zoom, and on every desktop.
            //
            // One place, not two: on a phone the thread panel is a full-screen
            // push rendered INSIDE this element, so both surfaces inherit it.
            style={{ paddingBottom: keyboardInset }}
            data-testid="room-surface"
            // A flex COLUMN, not a bare `h-full` box: the room column inside is
            // `flex-1`, which needs a flex parent to be bounded by. Without it the
            // scroller had no height to overflow, so the room silently stopped
            // scrolling on phones — it opened at the top and stayed there.
            className="flex h-full flex-col overflow-hidden"
          >
            {panel === false ? roomColumn : panel}
          </motion.div>
        </AnimatePresence>
      </Conversation.Root>
    );
  }

  return (
    <Conversation.Root {...conversation}>
      <div className="flex h-full overflow-hidden">
        {roomColumn}
        {panel}
      </div>
    </Conversation.Root>
  );
}
