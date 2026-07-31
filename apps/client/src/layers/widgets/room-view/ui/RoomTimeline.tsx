import { Fragment, useMemo } from 'react';
import { MessagesSquare } from 'lucide-react';
import { buildTimelineRows } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { Button, Skeleton } from '@/layers/shared/ui';
import type { RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { DayDivider, UnreadDivider } from '@/layers/features/chat';
import { authorsById, groupByThread, toMessageAuthor, unreadPlacement } from '../lib/room-timeline';
import { RoomEntryRow } from './RoomEntryRow';
import { RoomThreadReplyRow } from './RoomThreadReplyRow';

interface RoomTimelineProps {
  /** The room on screen. Every entry's actions act on it. */
  roomId: string;
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
  /** True while the first page of history is loading. */
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
 * What a room looks like before it has arrived.
 *
 * Its own component because two different waits render it — the room itself
 * loading, and the room's history loading under a masthead that is already
 * drawn — and a timeline that has no room yet cannot be asked for the room id
 * and reader identity its rows need.
 */
export function RoomTimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-busy data-testid="room-timeline-loading">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={`room-skeleton-${i}`} className="flex gap-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        </div>
      ))}
    </div>
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
 */
export function RoomTimeline({
  roomId,
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
  // Names only — a reaction names who reacted, and the roster is the only place
  // that can say. An id it does not hold belongs to somebody who has left.
  const authorNames = useMemo(
    () => new Map([...authors].map(([id, author]) => [id, author.displayName])),
    [authors]
  );
  // Ticked rather than read at render, so "Today" becomes "Yesterday" on its own
  // for a room left open across midnight.
  const now = useNow();
  const { topLevel, repliesByRoot, orphaned } = useMemo(() => groupByThread(entries), [entries]);
  const rows = useMemo(() => {
    const unread = unreadPlacement(topLevel, lastReadSeq);
    return buildTimelineRows(
      topLevel.map((entry) => ({
        id: entry.id,
        authorId: entry.authorId,
        timestamp: entry.createdAt,
      })),
      { now, lastSeenId: unread.lastSeenId, unreadFromStart: unread.fromStart }
    );
  }, [topLevel, lastReadSeq, now]);

  if (isLoading) return <RoomTimelineSkeleton />;

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

  if (entries.length === 0) {
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
    <div className="flex flex-col py-4" data-testid="room-timeline">
      {rows.map((row) => {
        if (row.kind === 'day-divider') return <DayDivider key={row.key} label={row.label} />;
        if (row.kind === 'unread-divider') return <UnreadDivider key={row.key} />;
        const entry = topLevel[row.index]!;
        const replies = repliesByRoot.get(entry.id);
        return (
          <Fragment key={entry.id}>
            <RoomEntryRow
              roomId={roomId}
              entry={entry}
              author={toMessageAuthor(entry.authorId, authors)}
              authorRef={authors.get(entry.authorId)}
              viewerAuthorId={viewerAuthorId}
              authorNames={authorNames}
              reactionFrequents={reactionFrequents}
              streamStalled={streamStalled}
              grouping={row.grouping}
              orphanedReply={orphaned.has(entry.id)}
            />
            {replies && (
              <RoomThreadReplyRow
                rootEntryId={entry.id}
                replies={replies}
                lastReadSeq={lastReadSeq}
                open={openThreadId === entry.id}
                onOpen={() => onOpenThread(entry.id)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
