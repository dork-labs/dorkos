import { useMemo } from 'react';
import { MessagesSquare } from 'lucide-react';
import { buildTimelineRows } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { Button, Skeleton } from '@/layers/shared/ui';
import type { RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { DayDivider, UnreadDivider } from '@/layers/features/chat';
import { authorsById, toMessageAuthor, unreadPlacement } from '../lib/room-timeline';
import { RoomEntryRow } from './RoomEntryRow';

interface RoomTimelineProps {
  /** The room's history, oldest first. */
  entries: RoomEntry[];
  /** The room's roster — the only place an author's name comes from. */
  members: RoomRosterEntry[];
  /** The reader's `(member, room)` cursor, or null when they are not a member. */
  lastReadSeq: number | null;
  /** True while the first page of history is loading. */
  isLoading: boolean;
  /** Set when the history could not be read. */
  error: unknown;
  /**
   * Open the members panel. The empty state promises you can put agents in
   * here, so this is what makes that promise a button (spec `rooms` §14.3).
   */
  onAddAgents: () => void;
}

/** Placeholder rows shown while a room's history loads. */
const SKELETON_ROWS = 4;

/**
 * A room's history: the same rows session chat renders — author groups, day
 * boundaries, and the rule marking where you left off — with more than two
 * people in them.
 *
 * The unread rule reads the membership cursor rather than anything in this
 * browser, so where you left off is the same on every device you open.
 */
export function RoomTimeline({
  entries,
  members,
  lastReadSeq,
  isLoading,
  error,
  onAddAgents,
}: RoomTimelineProps) {
  const authors = useMemo(() => authorsById(members), [members]);
  // Ticked rather than read at render, so "Today" becomes "Yesterday" on its own
  // for a room left open across midnight.
  const now = useNow();
  const rows = useMemo(() => {
    const unread = unreadPlacement(entries, lastReadSeq);
    return buildTimelineRows(
      entries.map((entry) => ({
        id: entry.id,
        authorId: entry.authorId,
        timestamp: entry.createdAt,
      })),
      { now, lastSeenId: unread.lastSeenId, unreadFromStart: unread.fromStart }
    );
  }, [entries, lastReadSeq, now]);

  if (isLoading) {
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
        const entry = entries[row.index]!;
        return (
          <RoomEntryRow
            key={entry.id}
            entry={entry}
            author={toMessageAuthor(entry.authorId, authors)}
            grouping={row.grouping}
          />
        );
      })}
    </div>
  );
}
