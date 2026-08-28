/**
 * A room's own flow, drawn on `Conversation.Timeline`.
 *
 * What is left of the retired `RoomTimeline` once the list itself is shared:
 * which rows a room has, who wrote them, and what each one is drawn with. The
 * scroller, the virtualizer, the feed, the thumb, the pending rows and the
 * jump-to-latest affordances are all the timeline's now, and a session gets the
 * identical ones from the identical code.
 *
 * A thread does NOT render here. An entry with replies carries one quiet
 * "↳ N replies · last 9:45 AM" row, and the replies themselves live in the side
 * panel (design record §3) — so the room's scroll stays the room's however long
 * a thread gets.
 *
 * A reply whose thread head is older than the loaded history still renders in
 * the flow and says that it is answering something out of view: it is a real
 * line in this room's log and nothing may drop it.
 *
 * The unread rule reads the membership cursor rather than anything in this
 * browser, so where you left off is the same on every device you open.
 *
 * @module widgets/room-view/ui/RoomFlow
 */
import { useCallback, useMemo, type Ref } from 'react';
import { MessagesSquare } from 'lucide-react';
import { buildTimelineRows, unreadPlacement } from '@/layers/shared/lib';
import type { MessageGrouping } from '@/layers/shared/model';
import { useNow } from '@/layers/shared/model';
import { Button, Feed, Skeleton } from '@/layers/shared/ui';
import type { RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { isRoomMember, usePendingPosts } from '@/layers/entities/room';
import {
  Conversation,
  DayDivider,
  ThreadReplyRow,
  UnreadDivider,
  type ConversationRow,
  type ConversationRowRenderer,
  type ConversationTimelineHandle,
} from '@/layers/features/conversation';
import {
  authorsById,
  entryRowId,
  answeredReference,
  groupByThread,
  threadRowId,
  threadRowKey,
  toMessageAuthor,
} from '../lib/room-timeline';
import { AgentInfoProvider, useRoomAgentDirectory } from '../model/agent-info-context';
import { RoomMessage } from './RoomMessage';

interface RoomFlowProps {
  /** The room on screen. Every entry's actions act on it. */
  roomId: string;
  /**
   * The room's own title, which names the feed. A page can hold more than one
   * scrollable history — the room and an open thread — so "Messages" alone
   * would leave a screen reader unable to say which one it had landed in.
   */
  roomName: string;
  /**
   * The reader's own author id, as the server resolved it for this request.
   * Always present — seeing a room and being a member of it are different
   * things, and this answers the first.
   */
  viewerAuthorId: string;
  /**
   * The room's whole history, oldest first — including thread replies. It
   * arrives unfiltered on purpose: the same array reaches `useMarkRoomRead`,
   * and {@link groupByThread} is the only thing allowed to leave a reply out.
   */
  entries: RoomEntry[];
  /** The room's roster — the only place an author's name comes from. */
  members: RoomRosterEntry[];
  /** The reader's `(member, room)` cursor, or null when they are not a member. */
  lastReadSeq: number | null;
  /** This reader's three most-used emoji, as the room read resolved them. */
  reactionFrequents: readonly string[];
  /** True when the room's live stream has given up — reactions go with it. */
  streamStalled?: boolean;
  /**
   * True while the first page of history is loading.
   *
   * The ONLY wait this feed has, which is why it is the only thing that sets
   * `aria-busy`. There is no second "articles are landing in the drawn feed"
   * state to report: the history query is `staleTime: Infinity` and nothing
   * invalidates it, so it is fetched exactly once — and the live stream merges
   * arriving entries one at a time with `setQueryData`.
   */
  isLoading: boolean;
  /** Set when the history could not be read. */
  error: unknown;
  /**
   * Open the members panel. The empty state promises you can put agents in
   * here, so this is what makes that promise a button (spec `rooms` §14.3).
   */
  onAddAgents: () => void;
  /** The thread the panel is showing, so its row can say it is open. */
  openThreadId?: string;
  /** Open one thread's panel. */
  onOpenThread: (rootEntryId: string) => void;
  /**
   * The row this room was left on, asked for when the flow lands.
   *
   * The HOST holds it, because on a phone the thread panel unmounts this whole
   * component and `RoomSurface` is what survives.
   */
  resumeRow?: () => string | undefined;
  /**
   * The row a search hit asked this room to open on, asked for at landing time.
   *
   * Passed straight through to `Conversation.Timeline`, which outranks every
   * other landing with it — see `useEntryLanding` for where the answer comes
   * from and `TimelineLandingInput.landOnRow` for why it wins.
   */
  landOnRow?: () => string | undefined;
  /** Told which row is at the top, or `undefined` when the reader is caught up. */
  onTopRow?: (rowId: string | undefined) => void;
  /** The timeline's handle, so the lane's peek can take a reader to a row. */
  ref?: Ref<ConversationTimelineHandle>;
}

/** Placeholder rows shown while a room's history loads. */
const SKELETON_ROWS = 4;

/**
 * What a room looks like before it has arrived.
 *
 * Its own component because two different waits render it — the room itself
 * loading, and the room's history loading under a masthead that is already
 * drawn — and a flow that has no room yet cannot be asked for the room id and
 * reader identity its rows need.
 */
export function RoomHistorySkeleton({ roomName }: { roomName?: string }) {
  return (
    // The same feed the loaded room renders, saying it is busy — which is what
    // the pattern asks for and why the wait is announced rather than silent. A
    // room whose NAME has not arrived either is labelled generically; it is a
    // second or two, and inventing a title would be worse.
    <Feed
      label={roomName === undefined ? 'Conversation' : `Messages in ${roomName}`}
      busy
      className="flex flex-col gap-4 p-4"
      data-testid="room-timeline-loading"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={`room-skeleton-${i}`} className="flex gap-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        </div>
      ))}
    </Feed>
  );
}

/**
 * One row of a room's flow, with everything drawing it needs.
 *
 * Kept beside the shared `ConversationRow` rather than folded into it: the
 * timeline needs an id and a kind, and this needs the entry, its group position
 * and its place in the room's own numbering. The two arrays are built in one
 * pass and indexed together, which is what `ConversationRowContext.index` is
 * for.
 */
type RoomFlowRow =
  | { kind: 'day-divider'; id: string; label: string }
  | { kind: 'unread-divider'; id: string }
  | {
      kind: 'message';
      id: string;
      entry: RoomEntry;
      grouping: MessageGrouping;
      position: number;
      /** What this post answers, when it is not the row directly above it. */
      answers: { entryId: string; excerpt: string } | null;
    }
  | { kind: 'thread-reply'; id: string; rootId: string; replies: RoomEntry[] };

/**
 * A room's history: the same rows a session transcript renders — author groups,
 * day boundaries, and the rule marking where you left off — with more than two
 * people in them.
 *
 * @param props - The room, its history and roster, and what to do with a thread.
 */
export function RoomFlow({
  roomId,
  roomName,
  viewerAuthorId,
  entries,
  members,
  lastReadSeq,
  reactionFrequents,
  streamStalled,
  isLoading,
  error,
  onAddAgents,
  openThreadId,
  onOpenThread,
  resumeRow,
  landOnRow,
  onTopRow,
  ref,
}: RoomFlowProps) {
  const authors = useMemo(() => authorsById(members), [members]);
  // Reactions go with the composer (DOR-1233): a room the operator sees but
  // is not a member of refuses a reaction the same `MEMBER_NOT_FOUND` way it
  // refuses a post, so the pills on every row here have to know it too.
  const isMember = isRoomMember(members, viewerAuthorId);
  // The fleet, read once for the whole feed: `info` is what a mention pill's
  // hover card reads, `faces` is what each message's disc wears. Both come from
  // the same pass, so an agent cannot be one face in the gutter and another in
  // the card that opens off it.
  const agents = useRoomAgentDirectory();
  // Names only — a reaction names who reacted, and the roster is the only place
  // that can say. An id it does not hold belongs to somebody who has left.
  const authorNames = useMemo(
    () => new Map([...authors].map(([id, author]) => [id, author.displayName])),
    [authors]
  );
  // Ticked rather than read at render, so "Today" becomes "Yesterday" on its own
  // for a room left open across midnight.
  const now = useNow();
  // What this reader has sent into the room's own flow and not yet seen back.
  // Read here rather than passed in: it is the room's own id that answers it,
  // and threading it through the page would put a prop on every caller for a
  // fact this component can simply ask for.
  const pending = usePendingPosts(roomId, null);
  const { topLevel, repliesByRoot, orphaned } = useMemo(() => groupByThread(entries), [entries]);
  // Every loaded entry by id, so resolving what a post answers is one lookup
  // rather than a scan per row.
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  const flowRows = useMemo<RoomFlowRow[]>(() => {
    const unread = unreadPlacement(topLevel, lastReadSeq);
    const laid = buildTimelineRows(
      topLevel.map((entry) => ({
        id: entry.id,
        // A moment groups with nothing, and that is the whole reason it carries
        // an id of its own here. It draws its own band rather than the message
        // grid (`MomentRow`), so an agent's next message — same author, same
        // minute — would have been laid out as a CONTINUATION of it and arrive
        // with no avatar and no name under a row that never showed one.
        authorId: entry.body.moment ? `moment:${entry.id}` : entry.authorId,
        timestamp: entry.createdAt,
      })),
      { now, lastSeenId: unread.lastSeenId, unreadFromStart: unread.fromStart }
    );

    const built: RoomFlowRow[] = [];
    for (const row of laid) {
      if (row.kind === 'day-divider') {
        built.push({ kind: 'day-divider', id: row.key, label: row.label });
        continue;
      }
      if (row.kind === 'unread-divider') {
        built.push({ kind: 'unread-divider', id: row.key });
        continue;
      }
      const entry = topLevel[row.index]!;
      built.push({
        kind: 'message',
        id: entry.id,
        entry,
        grouping: row.grouping,
        position: row.index + 1,
        // Against the room's OWN flow, which is what the reader sees: the entry
        // directly above this one here, not the previous entry in the log. A
        // thread reply sits in the panel, so it is not what is above anything.
        answers: answeredReference(entry, topLevel[row.index - 1], byId.get.bind(byId)),
      });
      const replies = repliesByRoot.get(entry.id);
      if (replies) {
        built.push({
          kind: 'thread-reply',
          id: threadRowKey(entry.id),
          rootId: entry.id,
          replies,
        });
      }
    }
    return built;
  }, [topLevel, repliesByRoot, byId, lastReadSeq, now]);

  const rows = useMemo<ConversationRow[]>(
    () =>
      flowRows.map((row) => {
        if (row.kind === 'day-divider')
          return { kind: 'day-divider', id: row.id, label: row.label };
        if (row.kind === 'unread-divider') return { kind: 'unread-divider', id: row.id };
        if (row.kind === 'thread-reply')
          return {
            kind: 'thread-reply',
            id: row.id,
            rootId: row.rootId,
            replyCount: row.replies.length,
            lastAt: row.replies[row.replies.length - 1]!.createdAt,
          };
        return {
          kind: 'message',
          id: row.id,
          payload: row.entry,
          grouping: row.grouping,
          author: toMessageAuthor(row.entry.authorId, authors, agents.faces),
          at: row.entry.createdAt,
        };
      }),
    [flowRows, authors, agents.faces]
  );

  const renderRow = useCallback<ConversationRowRenderer>(
    (_row, ctx) => {
      const row = flowRows[ctx.index]!;
      if (row.kind === 'day-divider') return <DayDivider label={row.label} />;
      if (row.kind === 'unread-divider') return <UnreadDivider />;
      if (row.kind === 'thread-reply') {
        // `onOpenThread` arrives through the context, which is `undefined` on a
        // surface without threads — so a reply row can only exist where a panel
        // exists to open.
        if (ctx.onOpenThread === undefined) return null;
        const open = ctx.onOpenThread;
        return (
          <ThreadReplyRow
            id={threadRowId(row.rootId)}
            replies={row.replies}
            lastReadSeq={lastReadSeq}
            open={openThreadId === row.rootId}
            onOpen={() => open(row.rootId)}
          />
        );
      }
      return (
        <RoomMessage
          roomId={roomId}
          entry={row.entry}
          author={toMessageAuthor(row.entry.authorId, authors, agents.faces)}
          authorRef={authors.get(row.entry.authorId)}
          authors={authors}
          viewerAuthorId={viewerAuthorId}
          authorNames={authorNames}
          reactionFrequents={reactionFrequents}
          streamStalled={streamStalled}
          isMember={isMember}
          grouping={row.grouping}
          orphanedReply={orphaned.has(row.entry.id)}
          answers={row.answers}
          // Where the row sits, counted over the room's own flow — a thread's
          // replies live in the panel, so numbering them here would promise a
          // reader articles they will never reach with Page Down.
          //
          // The SIZE is `-1`, which is the APG's "unknown", and it is the honest
          // answer: this is the trailing page of a room's history, so what is
          // loaded is not what there is.
          feedPosition={{ index: row.position, total: -1 }}
          // Only the flow's copy of an entry is addressable — see `entryRowId`.
          // It is where focus comes back to when the thread panel this row
          // opened closes again.
          rowId={entryRowId(row.entry.id)}
        />
      );
    },
    [
      flowRows,
      roomId,
      authors,
      agents.faces,
      viewerAuthorId,
      authorNames,
      reactionFrequents,
      streamStalled,
      isMember,
      orphaned,
      lastReadSeq,
      openThreadId,
    ]
  );

  /**
   * The DOM id a row answers to, so the peek can reach one that is not drawn.
   *
   * Virtualization is why this is needed at all: only the rows on screen exist
   * in the document, so `getElementById` alone would fail for anything a reader
   * has scrolled past.
   */
  const domIdOf = useCallback((row: ConversationRow): string | undefined => {
    if (row.kind === 'message') return entryRowId(row.id);
    if (row.kind === 'thread-reply') return threadRowId(row.rootId);
    return undefined;
  }, []);

  if (error) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
        <p className="text-foreground font-medium">Couldn&apos;t load this conversation</p>
        <p className="max-w-sm">
          Nothing was lost — a room keeps everything that was said. Reload to try again.
        </p>
      </div>
    );
  }

  // A room with nobody in it answers nothing, so the empty state says which
  // kind of empty this is rather than one line that is wrong half the time.
  const hasAgents = members.some((member) => member.author.kind === 'agent');
  const emptyState = (
    <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
      <MessagesSquare className="text-muted-foreground/50 size-8" aria-hidden />
      <p className="text-foreground font-medium">Nothing said here yet</p>
      <p className="max-w-sm">
        {hasAgents
          ? 'Say something to get it going. Everything said here stays here.'
          : 'There are no agents in here, so nothing will answer. Add one and it can read everything said here.'}
      </p>
      <Button
        type="button"
        size="sm"
        variant={hasAgents ? 'ghost' : 'default'}
        onClick={onAddAgents}
        className="mt-1"
      >
        {hasAgents ? 'Add more agents' : 'Add agents'}
      </Button>
    </div>
  );

  return (
    // Wrapped only around the drawn history: the states above have no messages
    // in them, so nothing there could carry a mention to look an agent up for.
    <AgentInfoProvider known={agents}>
      <Conversation.Timeline
        ref={ref}
        conversationId={roomId}
        label={`Messages in ${roomName}`}
        rows={rows}
        renderRow={renderRow}
        onOpenThread={onOpenThread}
        domIdOf={domIdOf}
        {...(resumeRow === undefined ? {} : { resumeRow })}
        {...(landOnRow === undefined ? {} : { landOnRow })}
        {...(onTopRow === undefined ? {} : { onTopRow })}
        pending={pending}
        viewerAuthorId={viewerAuthorId}
        loading={isLoading ? <RoomHistorySkeleton roomName={roomName} /> : undefined}
        empty={emptyState}
        // The shipped page object reads the SCROLLER by walking up from this
        // element, so it stays on the feed rather than moving to the wrapper.
        feedTestId="room-timeline"
      />
    </AgentInfoProvider>
  );
}
