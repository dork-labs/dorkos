import { useEffect, useMemo, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Skeleton } from '@/layers/shared/ui';
import { useMarkRoomRead, useRoom, useRoomEntries, useRoomStream } from '@/layers/entities/room';
import { useFrozenReadCursor } from '../model/use-frozen-read-cursor';
import { RoomHeader } from './RoomHeader';
import { RoomTimeline } from './RoomTimeline';

/**
 * The `/channels` page — one room's history, addressed by search param.
 *
 * `?thread=` wins over `?id=` when both are present: a thread is a room in its
 * own right, and the parent's id stays in the URL so leaving the thread returns
 * to the room it hangs off.
 */
export function ChannelsPage() {
  const { id, thread } = useSearch({ from: '/_shell/channels' });
  const roomId = thread ?? id ?? null;

  const roomQuery = useRoom(roomId);
  const entriesQuery = useRoomEntries(roomId);
  useRoomStream(roomId, entriesQuery.isSuccess);

  const room = roomQuery.data;
  const entries = useMemo(() => entriesQuery.data ?? [], [entriesQuery.data]);

  // v1 mints exactly one human author (spec `rooms` §2), so the roster's human
  // member IS the person reading — there is no "who am I" call to make, and
  // there will not be one until accounts land. Their cursor is what the unread
  // rule reads; `null` (not a member) draws no rule at all.
  const lastReadSeq = useMemo(
    () => room?.members.find((member) => member.author.kind === 'human')?.lastReadSeq ?? null,
    [room]
  );

  // Reading a room is what marks it read. The rule renders from the cursor as it
  // stood when the room opened, then the real cursor catches up — so you still
  // see where you left off, and the sidebar badge does not sit there claiming
  // you have not.
  const frozenReadSeq = useFrozenReadCursor(roomId, lastReadSeq);
  useMarkRoomRead(room, entries);

  // Open a room at its newest message, the way every chat surface does — a room
  // with a hundred lines of history would otherwise open on the oldest one.
  // Keyed on the newest entry rather than the array, so a live arrival scrolls
  // to itself and a re-render for any other reason does not.
  const scrollRef = useRef<HTMLDivElement>(null);
  const newestEntryId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || newestEntryId === null) return;
    el.scrollTop = el.scrollHeight;
  }, [roomId, newestEntryId]);

  if (roomId === null) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm">
        <MessagesSquare className="text-muted-foreground/50 size-10" aria-hidden />
        <p className="text-foreground font-medium">Pick a conversation</p>
        <p className="max-w-sm">
          Channels and direct messages live in the sidebar. Open one to read it, or make a new
          channel to get a few agents talking in the same place.
        </p>
      </div>
    );
  }

  if (roomQuery.isLoading) {
    return (
      <div className="flex h-full flex-col" aria-busy>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <RoomTimeline entries={[]} members={[]} lastReadSeq={null} isLoading error={null} />
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RoomHeader room={room} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <RoomTimeline
          entries={entries}
          members={room.members}
          lastReadSeq={frozenReadSeq}
          isLoading={entriesQuery.isLoading}
          error={entriesQuery.error}
        />
      </div>
      {/* Reading is all a room does today. Saying so beats a composer that
          silently does nothing, and beats leaving a person to wonder. */}
      <p className="text-muted-foreground border-t px-4 py-3 text-xs">
        You can read this room, but not post to it yet.
      </p>
    </div>
  );
}
