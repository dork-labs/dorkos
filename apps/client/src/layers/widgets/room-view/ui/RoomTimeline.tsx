import { Fragment, useMemo } from 'react';
import { MessagesSquare } from 'lucide-react';
import { buildTimelineRows, unreadPlacement } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { Button, Feed, Skeleton } from '@/layers/shared/ui';
import type { RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { isRoomMember, usePendingPosts } from '@/layers/entities/room';
import { DayDivider, ThreadReplyRow, UnreadDivider } from '@/layers/features/conversation';
import {
  authorsById,
  entryRowId,
  groupByThread,
  threadRowId,
  toMessageAuthor,
} from '../lib/room-timeline';
import { AgentInfoProvider, useRoomAgentDirectory } from '../model/agent-info-context';
import { RoomMessage } from './RoomMessage';
import { RoomPendingList } from './RoomPendingRow';

interface RoomTimelineProps {
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
   * invalidates it (`query-keys.ts` says why), so it is fetched exactly once —
   * and the live stream merges arriving entries one at a time with
   * `setQueryData`, which is a single commit per entry with no window around it
   * to call busy. A flag for that would have been a `false` dressed up as
   * bookkeeping.
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
}

/** Placeholder rows shown while a room's history loads. */
const SKELETON_ROWS = 4;

/**
 * Take the reader to one row, and leave them standing on it.
 *
 * The interim shape of `ConversationTimelineHandle.scrollToRow`, which lands
 * with `Conversation.Timeline` in P4 (DOR-1331). It is a module function rather
 * than an imperative handle because neither list owns its own scroller —
 * `RoomSurface` and `RoomThreadPanel` do — and `scrollIntoView` needs neither:
 * it walks to whatever scrollable ancestor the row happens to have.
 *
 * **It takes a DOM id, not an entry id, and that is what makes the caller
 * honest.** An entry can be perfectly quotable and still have no row on screen:
 * a reply lives in the thread panel and never in the room's flow, and on a
 * phone the room column is unmounted entirely while a thread is open. So the
 * caller decides which element it is aiming at, and asks this whether it exists
 * — see `RoomLiveLane`, which draws no "replying to" link at all when the
 * answer would be nothing.
 *
 * **Focus IS the flash**, and deliberately so. Every room row is already a tab
 * stop with a focus ring (`RoomMessage`), so landing the caret on the row marks
 * it, keeps it marked while the reader looks, and puts a keyboard reader in the
 * same place a mouse reader is — which a fading highlight does for neither. It
 * is also how `useRestoreThreadFocus` already returns somebody to a row.
 *
 * @param rowId - The DOM id of the row to go to.
 * @returns Whether a row with that id was on the page.
 */
export function scrollToRow(rowId: string): boolean {
  const row = document.getElementById(rowId);
  if (row === null) return false;
  row.scrollIntoView({ block: 'center' });
  // `preventScroll`, because the line above has already put the row exactly
  // where it should be and the browser's own focus scroll would move it again.
  row.focus({ preventScroll: true });
  return true;
}

/**
 * What a room looks like before it has arrived.
 *
 * Its own component because two different waits render it — the room itself
 * loading, and the room's history loading under a masthead that is already
 * drawn — and a timeline that has no room yet cannot be asked for the room id
 * and reader identity its rows need.
 */
export function RoomTimelineSkeleton({ roomName }: { roomName?: string }) {
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
 * A room's history: the same rows session chat renders — author groups, day
 * boundaries, and the rule marking where you left off — with more than two
 * people in them.
 *
 * A thread does NOT render here. An entry with replies carries one quiet
 * "↳ N replies · last 9:45 AM" row, and the replies themselves live in the side
 * panel (design record §3) — so the room's scroll stays the room's however long
 * a thread gets. The inline gathering this replaced is retired.
 *
 * A reply whose thread head is older than the loaded history still renders in
 * the flow and says that it is answering something out of view: it is a real
 * line in this room's log and nothing may drop it.
 *
 * The unread rule reads the membership cursor rather than anything in this
 * browser, so where you left off is the same on every device you open.
 *
 * **It is a feed** (WAI-ARIA `role="feed"`), which is what makes crossing it
 * bearable without a mouse: Page Down and Page Up step message to message
 * however many buttons, pills and reply rows each one carries, and Ctrl+Home /
 * Ctrl+End leave for the controls above and the composer below. Every message
 * is a named article that says where it sits in the room's flow, so a screen
 * reader can say "message 12 of 30, Ana" rather than reading the room out as
 * one undifferentiated wall. The day and unread rules stay as separators
 * BETWEEN articles: they are real to a reader and there is nothing in them to
 * stand on. `Feed` explains why the mechanics live in `shared` rather than
 * here.
 */
export function RoomTimeline({
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
}: RoomTimelineProps) {
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
  const rows = useMemo(() => {
    const unread = unreadPlacement(topLevel, lastReadSeq);
    return buildTimelineRows(
      topLevel.map((entry) => ({
        id: entry.id,
        // A moment groups with nothing, and that is the whole reason it carries
        // an id of its own here. It draws its own band rather than the message
        // grid (`MomentRow`), so an agent's next message — same author,
        // same minute — would have been laid out as a CONTINUATION of it and
        // arrive with no avatar and no name under a row that never showed one.
        authorId: entry.body.moment ? `moment:${entry.id}` : entry.authorId,
        timestamp: entry.createdAt,
      })),
      { now, lastSeenId: unread.lastSeenId, unreadFromStart: unread.fromStart }
    );
  }, [topLevel, lastReadSeq, now]);

  if (isLoading) return <RoomTimelineSkeleton roomName={roomName} />;

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

  // A room with a message in flight is not an empty room, whatever the log
  // says — the first thing anybody ever sends here would otherwise vanish into
  // an illustration telling them to say something.
  if (entries.length === 0 && pending.length === 0) {
    // A room with nobody in it answers nothing, so the empty state says which
    // kind of empty this is rather than one line that is wrong half the time.
    const hasAgents = members.some((member) => member.author.kind === 'agent');
    return (
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
  }

  return (
    // Wrapped only around the drawn history: the states above have no messages
    // in them, so nothing there could carry a mention to look an agent up for.
    <AgentInfoProvider known={agents}>
      <Feed
        label={`Messages in ${roomName}`}
        className="flex flex-col py-4"
        data-testid="room-timeline"
      >
        {rows.map((row) => {
          if (row.kind === 'day-divider') return <DayDivider key={row.key} label={row.label} />;
          if (row.kind === 'unread-divider') return <UnreadDivider key={row.key} />;
          const entry = topLevel[row.index]!;
          const replies = repliesByRoot.get(entry.id);
          return (
            <Fragment key={entry.id}>
              <RoomMessage
                roomId={roomId}
                entry={entry}
                author={toMessageAuthor(entry.authorId, authors, agents.faces)}
                authorRef={authors.get(entry.authorId)}
                authors={authors}
                viewerAuthorId={viewerAuthorId}
                authorNames={authorNames}
                reactionFrequents={reactionFrequents}
                streamStalled={streamStalled}
                isMember={isMember}
                grouping={row.grouping}
                orphanedReply={orphaned.has(entry.id)}
                // Where the row sits, counted over the room's own flow — a
                // thread's replies live in the panel, so numbering them here
                // would promise a reader articles they will never reach with
                // Page Down.
                //
                // The SIZE is `-1`, which is the APG's "unknown", and it is the
                // honest answer: this is the trailing page of a room's history
                // (`useRoomEntries`), so what is loaded is not what there is.
                // Saying "12 of 50" over a room that has been going for a month
                // tells a reader they are near the end of a conversation that
                // has barely started.
                feedPosition={{ index: row.index + 1, total: -1 }}
                // Only the timeline's copy of an entry is addressable — see
                // `rowId`. It is where focus comes back to when the thread
                // panel this row opened closes again.
                rowId={entryRowId(entry.id)}
              />
              {replies && (
                <ThreadReplyRow
                  id={threadRowId(entry.id)}
                  replies={replies}
                  lastReadSeq={lastReadSeq}
                  open={openThreadId === entry.id}
                  onOpen={() => onOpenThread(entry.id)}
                />
              )}
            </Fragment>
          );
        })}
      </Feed>
      {/* Below the log, at the tail, where the message is about to appear —
          and outside the feed, because a message the server has not accepted
          yet is not one of its numbered articles. */}
      <RoomPendingList posts={pending} viewerAuthorId={viewerAuthorId} />
    </AgentInfoProvider>
  );
}
