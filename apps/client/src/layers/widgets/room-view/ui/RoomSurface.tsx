import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
  usePendingPosts,
  roomDisplayTitle,
  threadRootIdOf,
} from '@/layers/entities/room';
import { RoomDetailsDialog, type RoomDetailsFocus } from '@/layers/features/room-management';
import { useFrozenReadCursor } from '../model/use-frozen-read-cursor';
import { useRestoreThreadFocus } from '../model/use-restore-thread-focus';
import { useStickToBottom } from '../model/use-stick-to-bottom';
import { useThreadUrlSync, type ThreadRoute } from '../model/use-thread-url-sync';
import { RoomComposer } from './RoomComposer';
import { RoomHeader } from './RoomHeader';
import { RoomPresenceLine } from './RoomPresenceLine';
import { RoomStalledNotice } from './RoomStalledNotice';
import { RoomThreadPanel } from './RoomThreadPanel';
import { RoomTimeline, RoomTimelineSkeleton } from './RoomTimeline';

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
   * the scrolling element moves `scrollHeight` under `useStickToBottom` — which
   * reads the distance from the bottom to decide whether the reader is still
   * following the room. A header that grows inside it therefore un-pins a
   * reader who never scrolled. Here it is a flex sibling: it takes its own
   * space, the feed keeps its own scroll, and the two never argue.
   */
  aboveTimeline?: ReactNode;
  /**
   * Float "Jump back in" over this room's composer while the box is empty.
   *
   * Opt-in, and on for the home surface only (spec D2.3): the panel is an
   * answer to "you have just arrived, where were you?", which is a question
   * only the page you land on is asking.
   */
  offerJumpBackIn?: boolean;
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
  offerJumpBackIn,
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

  const newestEntryId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  // The timeline draws these under the log and reads them for itself; the pin
  // needs them too, because they are what the tail of the room actually is
  // between pressing Enter and the echo landing (DOR-799).
  const pendingPosts = usePendingPosts(roomId, null);
  const { scrollRef, onScroll } = useStickToBottom(roomId, newestEntryId, pendingPosts);

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
        <RoomTimelineSkeleton />
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
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <RoomTimeline
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
        />
      </div>
      {/* Directly above the composer, because the state it describes is about
          what happens after you press Enter. `RoomStalledNotice` explains why
          the composer beside it stays open. */}
      <RoomStalledNotice
        stalled={stream.stalled}
        onRetry={stream.retry}
        unavailable={stream.unavailable}
      />
      {/* Keyed on the room so opening a conversation gives you a composer that
          is focused and freshly sized for that room's draft. Switching to an
          already-read room takes none of the early returns above, so without
          this React reuses the instance and the input's own internals — focus,
          height, a part-typed IME composition — carry across. The DRAFT is safe
          either way; it belongs to the room, not to this element. */}
      <RoomComposer key={room.id} room={room} offerJumpBackIn={offerJumpBackIn} />

      {/* Under the composer, where a line about the wait belongs: it is about
          what happens after you press Enter, and putting it above would push
          the last message every time an agent picked something up.

          Scoped to everything OUTSIDE the open thread, so an agent working on a
          thread reply is announced in the panel instead of here — one claim,
          one line, in the place the work is happening. */}
      <RoomPresenceLine roomId={room.id} members={room.members} scope={threadScope} />

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
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {roomColumn}
      {panel}
    </div>
  );
}
