import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { RoomEntry, RoomWithRoster } from '@/layers/entities/room';
import {
  isRoomMember,
  roomDisplayTitle,
  threadRootIdOf,
  usePendingPosts,
  useRoomPresenceAuthorIds,
} from '@/layers/entities/room';
import {
  Conversation,
  type ConversationRow,
  type ConversationRowRenderer,
  type ConversationTimelineHandle,
} from '@/layers/features/conversation';
import {
  answeredReference,
  authorsById,
  threadPanelRowId,
  toMessageAuthor,
} from '../lib/room-timeline';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';
import { useRoomTarget } from '../model/room-target';
import { AgentInfoProvider, useRoomAgentDirectory } from '../model/agent-info-context';
import { useThreadArrivals } from '../model/use-thread-arrivals';
import { ChannelComposer } from './ChannelComposer';
import { RoomLiveLane } from './RoomLiveLane';
import { RoomMessage } from './RoomMessage';
import { ThreadNotice, type ThreadNoticeKind } from './ThreadNotice';

interface RoomThreadPanelProps {
  /** The room the thread lives in. */
  room: RoomWithRoster;
  /** The entry heading the open thread. */
  rootEntryId: string;
  /**
   * True when the reader opened this to write. The composer takes the caret;
   * otherwise the panel takes it, so Escape closes without a click first.
   */
  focusComposer: boolean;
  /**
   * The room's whole history, oldest first. The panel finds its own root and
   * replies in here rather than being handed them, so a reply arriving on the
   * stream reaches it by the same path everything else does.
   */
  entries: RoomEntry[];
  /** This reader's three most-used emoji, as the room read resolved them. */
  reactionFrequents: readonly string[];
  /** True when the room's live stream has given up. */
  streamStalled?: boolean;
  /** True when it has given up for good — see `RoomStreamState.unavailable`. */
  streamUnavailable?: boolean;
  /**
   * Ask the room's stream to try now.
   *
   * The panel reports a stall only when it is the whole screen — see the notice
   * below the feed — so this is unused beside a room that is drawing its own.
   */
  onRetryStream?: () => void;
  /**
   * Whether the room's history has actually arrived.
   *
   * Two things depend on telling "loading" apart from "empty": a thread whose
   * root has not loaded yet is not an orphaned thread, and a reply that was
   * always there is not an arrival.
   */
  historyLoaded: boolean;
  /**
   * True when the read of the room's history FAILED.
   *
   * Its own input rather than the absence of {@link RoomThreadPanelProps.historyLoaded},
   * because those are three states and not two: a fetch that errored is not
   * still arriving, and treating it as such leaves the panel drawing a skeleton
   * and announcing a wait that will never end.
   */
  historyFailed?: boolean;
  /** True when this is the mobile full-screen push rather than the side panel. */
  pushed: boolean;
  /** Close the panel. */
  onClose: () => void;
}

/**
 * One thread, with its own composer, beside the room.
 *
 * **The operator chose this over the inline gathering** (design record §3), and
 * the reason is the room's scroll: replies drawn in the flow make the timeline
 * belong to whichever thread is longest, and a room stops reading as a room.
 * Here the room shows a room, and the thread has a place — so a forty-reply
 * aside costs the conversation it hangs off exactly one quiet line.
 *
 * Root at the top with its own reactions, replies beneath it on a connector.
 * Each reply is an ordinary {@link RoomMessage}, so it carries the same
 * capsule, the same reactions and the same keyboard model it would anywhere
 * else — a thread is a different PLACE, not a different kind of message.
 *
 * **Presence follows you in** (design record §3.2): an agent working on
 * something inside this thread is announced here rather than under the room's
 * composer, and `PresenceScope` explains why the two lines are complements
 * rather than copies.
 *
 * **The thread is a feed of its own** (WAI-ARIA `role="feed"`), the same
 * pattern the room timeline uses and named for the thread rather than the room,
 * because on a desktop both are on screen at once. Page Down and Page Up cross
 * the root and its replies a message at a time, and Ctrl+Home / Ctrl+End leave
 * for the two controls that bracket it — the header's close button and this
 * thread's own composer — so leaving the feed never means landing in the room
 * behind the panel. It says it is busy while the room's history is still
 * arriving, which is the deep-link case: `?thread=` mounts this before there is
 * anything to show.
 *
 * Three ways out, because the panel is a mode and a mode needs an unmissable
 * exit: the close button, Escape, and clicking another thread's reply row
 * (which switches rather than stacking). On a phone it is a full-screen push
 * and the button becomes Back, naming the room it returns to.
 */
export function RoomThreadPanel({
  room,
  rootEntryId,
  focusComposer,
  entries,
  reactionFrequents,
  streamStalled,
  streamUnavailable,
  onRetryStream,
  historyLoaded,
  historyFailed = false,
  pushed,
  onClose,
}: RoomThreadPanelProps) {
  const authors = useMemo(() => authorsById(room.members), [room.members]);
  // The thread's OWN target. A reply goes to this thread, not to the room
  // behind the panel, so the panel publishes a conversation of its own — the
  // composer is physically inside the thread it posts to, which is the whole
  // reason there is no aim to set and no banner saying where the next sentence
  // is going (design record §3).
  const threadTarget = useRoomTarget({ room, threadRootId: rootEntryId });
  // Same reason the room's own timeline reads it (DOR-1233): a reaction here
  // refuses `MEMBER_NOT_FOUND` too, once the room this thread lives in is one
  // the viewer left.
  const isMember = isRoomMember(room.members, room.viewerAuthorId);
  // The same fleet read the room's own feed makes — a reply draws the same
  // faces the message it hangs off does.
  const agents = useRoomAgentDirectory();
  const authorNames = useMemo(
    () => new Map([...authors].map(([id, author]) => [id, author.displayName])),
    [authors]
  );

  const { root, replies } = useMemo(() => {
    let found: RoomEntry | undefined;
    const gathered: RoomEntry[] = [];
    for (const entry of entries) {
      if (entry.id === rootEntryId) found = entry;
      else if (threadRootIdOf(entry) === rootEntryId) gathered.push(entry);
    }
    return { root: found, replies: gathered };
  }, [entries, rootEntryId]);

  // What the feed holds, which is the root and its replies and nothing else:
  // the orphan line and the connectors are furniture between articles, with
  // nothing in them to stand on.
  //
  // `-1` — the APG's "I do not know" — whenever the ROOT is missing. The panel
  // reads the thread out of the room's loaded page, so a root that is not in
  // that page means the page starts somewhere inside this thread and the
  // replies above it are unread history, not absent replies. Counting what is
  // on screen would promise a reader "3 of 3" over the middle of a
  // conversation. With the root present, every reply after it is loaded too,
  // and the count is exact.
  const articleCount = root === undefined ? -1 : 1 + replies.length;

  // Scoped to the REPLIES, never the root — `PresenceScope` says why an agent
  // triggered by the root is the room's business and not this thread's.
  const replyIds = useMemo(() => new Set(replies.map((reply) => reply.id)), [replies]);
  const scope = useMemo(() => ({ replyIds, inside: true }), [replyIds]);
  // The NAMES, not the elapsed times: this panel only needs to know whose
  // answer a landing reply is. Reading the ticking hook here redrew the whole
  // panel — every reply, every reaction row, every action bar — once a second
  // for as long as an agent was working, to recompute a number nothing here
  // draws. `useRoomPresenceAuthorIds` says why that is a second hook rather
  // than a memo; the presence LINE at the foot of the panel still ticks, and it
  // is a leaf.
  const workingAuthorIds = useRoomPresenceAuthorIds(room.id, scope);
  // Scoped to THIS thread: a reply typed here waits here, not at the bottom of
  // the room behind the panel.
  const pending = usePendingPosts(room.id, rootEntryId);
  const arrivals = useThreadArrivals(replies, workingAuthorIds, historyLoaded);

  // Following the thread down as replies land is the timeline's job now — the
  // same `anchorTo: 'end'` that keeps a room and a session pinned. The panel
  // kept its own `scrollTop` write only because it had no shared list to
  // inherit one from.
  const timelineRef = useRef<ConversationTimelineHandle>(null);
  const scrollToRow = useCallback((domId: string) => {
    timelineRef.current?.scrollToRow(domId);
  }, []);

  /**
   * The panel takes focus when its composer is not going to.
   *
   * Not politeness: Escape is one of the three ways out, and a keydown only
   * reaches the handler below if focus is INSIDE the panel. Opening a thread
   * from a reply row leaves focus on that row, up in the timeline — so without
   * this, the panel could be opened by keyboard and not closed by one.
   */
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusComposer) panelRef.current?.focus();
  }, [rootEntryId, focusComposer]);

  /**
   * Escape closes, from anywhere inside the panel.
   *
   * On the container rather than on `window`: a global listener would fight
   * every other Escape the panel contains — the mention palette dismisses on
   * it, and the composer's double-Escape clears a draft — and closing the whole
   * thread because somebody dismissed an autocomplete is the wrong outcome
   * every time. Handled only when nothing inside has already taken it.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.stopPropagation();
    onClose();
  };

  /**
   * The thread's rows: what is known about its head, then every reply.
   *
   * The three things a panel can say instead of a root — it failed, it has not
   * arrived, it is gone — are `notice` rows rather than chrome above the list,
   * because they are part of the log rather than furniture around it: a reply
   * that IS loaded still renders under the sentence explaining why its head is
   * not.
   */
  const panelRows = useMemo<ConversationRow[]>(() => {
    const built: ConversationRow[] = [];
    if (root === undefined) {
      const id = historyFailed
        ? 'thread-error'
        : historyLoaded
          ? 'thread-orphan'
          : 'thread-waiting';
      built.push({ kind: 'notice', id, at: '', body: null });
    } else {
      built.push({
        kind: 'message',
        id: root.id,
        payload: root,
        grouping: { position: 'only' },
        author: toMessageAuthor(root.authorId, authors, agents.faces),
        at: root.createdAt,
      });
    }
    for (const reply of replies) {
      built.push({
        kind: 'message',
        id: reply.id,
        payload: reply,
        grouping: { position: 'only' },
        author: toMessageAuthor(reply.authorId, authors, agents.faces),
        at: reply.createdAt,
      });
    }
    return built;
  }, [root, replies, authors, agents.faces, historyFailed, historyLoaded]);

  const renderRow = useCallback<ConversationRowRenderer>(
    (row) => {
      if (row.kind === 'notice') {
        return <ThreadNotice kind={row.id as ThreadNoticeKind} />;
      }
      if (row.kind !== 'message') return null;
      const entry = row.payload as RoomEntry;
      const isRoot = root !== undefined && entry.id === root.id;
      const replyIndex = replies.findIndex((reply) => reply.id === entry.id);
      const message = (
        <RoomMessage
          roomId={room.id}
          entry={entry}
          // Its own id namespace: the root is drawn in the room's flow too, and
          // one id on two elements resolves to whichever the document holds
          // first (`threadPanelRowId`).
          rowId={threadPanelRowId(entry.id)}
          author={row.author}
          authorRef={authors.get(entry.authorId)}
          authors={authors}
          viewerAuthorId={room.viewerAuthorId}
          authorNames={authorNames}
          reactionFrequents={reactionFrequents}
          streamStalled={streamStalled}
          isMember={isMember}
          grouping={{ position: 'only' }}
          // Against the PANEL's own order, which is what a reader here sees: the
          // root, then the replies. A reply that answers the one above it needs
          // no chip; one that answers something further back does.
          answers={answeredReference(
            entry,
            replyIndex <= 0 ? root : replies[replyIndex - 1],
            (id: string) => (root?.id === id ? root : replies.find((reply) => reply.id === id))
          )}
          feedPosition={{
            // After the root where there is one. An orphaned thread numbers from
            // its first surviving reply rather than leaving a gap for the message
            // that is gone: Page Down can only reach what is here, and the count
            // should promise nothing else.
            index: isRoot ? 1 : (root === undefined ? 0 : 1) + replyIndex + 1,
            total: articleCount,
          }}
        />
      );
      if (isRoot) return message;
      const arrival = arrivals.get(entry.id) ?? 'at-rest';
      return (
        <div className={cn('relative flex', replyIndex === 0 && 'mt-2')}>
          {/* The connector. It draws downward as a reply lands (design record
              §5.3) and is otherwise simply there. */}
          <span
            aria-hidden
            data-testid="room-thread-connector"
            className={cn(
              'bg-border ml-[calc(var(--msg-padding-x)_+_var(--msg-gutter-width)_/_2)] w-px shrink-0',
              arrival === 'dropped' && 'motion-safe:animate-thread-line-draw'
            )}
          />
          <div
            className={cn(
              'min-w-0 flex-1',
              // Two arrivals, two motions, and the difference is real: an
              // ordinary reply drops in from above with a bounce; an answer from
              // an agent that was just on the presence line rises into the space
              // that line is leaving.
              arrival === 'dropped' && 'motion-safe:animate-thread-reply-in',
              arrival === 'handed-off' && 'motion-safe:animate-reply-settle'
            )}
          >
            {message}
          </div>
        </div>
      );
    },
    [
      root,
      replies,
      arrivals,
      room.id,
      room.viewerAuthorId,
      authors,
      authorNames,
      reactionFrequents,
      streamStalled,
      isMember,
      articleCount,
    ]
  );

  const domIdOf = useCallback(
    (row: ConversationRow) => (row.kind === 'message' ? threadPanelRowId(row.id) : undefined),
    []
  );

  return (
    // The thread draws the same messages the room does, mentions and all, so it
    // needs the same answer about how the agents in them run.
    <AgentInfoProvider known={agents}>
      {/* The thread's own conversation: same capabilities as the room it lives
          in, and a target that writes into THIS thread. Nested inside the
          room's own Root, which is what a reply is. */}
      <Conversation.Root
        surface={room.kind === 'dm' ? 'dm' : 'room'}
        capabilities={ROOM_CAPABILITIES}
        target={threadTarget.target}
        anchor="rail"
      >
        {/*
        A panel is a region, not a control: it holds the thread's messages and
        their own buttons, and none of that may sit inside an interactive
        element. But Escape is one of its three ways out, and a key only reaches
        it if this element hears one — so it is focusable (`tabIndex={-1}`, taken
        on open) and listens, without pretending to be a button. Same shape as
        `RoomMessage`, which carries the identical carve-out for the identical
        reason.
      */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above */}
        <section
          ref={panelRef}
          aria-label="Thread"
          data-testid="room-thread-panel"
          // Focusable but not tabbable: it is a destination for the focus the panel
          // takes on open, never an extra stop on the way to the composer.
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className={cn(
            'bg-card flex min-h-0 flex-col outline-none',
            // The push IS the room on a phone — it takes the whole surface, with a
            // Back button where the header's close would be. The side panel is a
            // column beside it, bounded so a long thread cannot squeeze the room
            // out of its own screen.
            pushed ? 'h-full w-full' : 'w-full max-w-md min-w-80 basis-2/5 border-l'
          )}
        >
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              aria-label={pushed ? `Back to ${roomDisplayTitle(room)}` : 'Close thread'}
              className={cn(
                'focus-ring text-muted-foreground hover:text-foreground relative -ml-1 rounded p-1',
                // 24px of button, and on a phone this is Back — the control a
                // reader reaches for most and the one that costs the most to miss.
                // The glyph stays 16px so the header keeps its height; the target
                // grows to 44px with 10px of reach on every side.
                //
                // **The one invisible reach left on this surface, and deliberately
                // so.** Everywhere else the rule is now "grow the real box", because
                // reach that overlaps a neighbour is worse than no reach at all —
                // the pills and the thread reply row collided exactly that way. This
                // one is the exception because it is alone: the panel header holds
                // no other control, only the thread title beside it, which is text
                // and takes no taps. Measured in Chromium at 390×844 — 44×42
                // effective, inside a 62px header, colliding with nothing. Reach is
                // safe when there is nothing to reach into; that is the test to
                // apply before copying this anywhere else.
                'after:absolute after:-inset-2.5 md:after:hidden'
              )}
            >
              {pushed ? (
                <ChevronLeft aria-hidden className="size-4" />
              ) : (
                <X aria-hidden className="size-4" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Thread</p>
              <p className="text-muted-foreground truncate text-xs">{roomDisplayTitle(room)}</p>
            </div>
          </header>

          <Conversation.Timeline
            ref={timelineRef}
            // Keyed on the THREAD, not the room: the panel is its own scroller,
            // and where a reader stands in a thread has nothing to do with where
            // they stand in the room behind it.
            conversationId={`thread-${rootEntryId}`}
            // Named for the THREAD, not the room: on a desktop both histories are
            // on screen at once, and two feeds called the same thing leave a
            // reader unable to say which one they have landed in.
            label={`Thread in ${roomDisplayTitle(room)}`}
            // The deep-link case. `?thread=` mounts this panel before the room's
            // entries arrive, and a feed that is briefly empty because it is
            // still waiting should say so rather than read as a thread of none.
            // A read that FAILED is not still waiting, and a feed left busy over
            // one is a promise nothing is going to keep.
            busy={!historyLoaded && !historyFailed}
            rows={panelRows}
            renderRow={renderRow}
            domIdOf={domIdOf}
            // Replies of this reader's own that the thread has not echoed back.
            // Scoped to THIS thread: a reply typed here waits here, not at the
            // bottom of the room behind the panel.
            pending={pending}
            viewerAuthorId={room.viewerAuthorId}
            className="py-3"
            feedTestId="room-thread-feed"
          />

          {/* The thread's own lane, above its own composer, scoped to the claims
          triggered INSIDE this thread — so one agent's work is announced once,
          in the place the work is happening.

          **The stalled rung is this lane's only on a phone**, which is the rule
          the notice it replaces carried: on a phone the thread REPLACES the
          room, so the room's own lane is off screen and the reader would have no
          way to know the conversation had stopped hearing. Beside a room that is
          already saying it, repeating it would be the same sentence twice. */}
          <RoomLiveLane
            room={room}
            entries={entries}
            scope={scope}
            laneScope="thread"
            stalled={pushed && streamStalled === true}
            unavailable={streamUnavailable}
            onRetry={pushed ? onRetryStream : undefined}
            onScrollToRow={scrollToRow}
          />

          {/* Writes into THIS thread because it is mounted here — no aim, no
          banner. `key` on the thread so opening another one gives you a box
          freshly sized for its own draft rather than the last thread's. */}
          <ChannelComposer
            key={rootEntryId}
            room={room}
            threadRootId={rootEntryId}
            attachments={threadTarget.attachments}
            focusOnMount={focusComposer}
          />
        </section>
      </Conversation.Root>
    </AgentInfoProvider>
  );
}
