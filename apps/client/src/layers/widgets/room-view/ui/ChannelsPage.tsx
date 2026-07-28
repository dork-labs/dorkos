import { useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Skeleton } from '@/layers/shared/ui';
import { useMarkRoomRead, useRoom, useRoomEntries, useRoomStream } from '@/layers/entities/room';
import {
  RoomMembersDialog,
  useAgentPickerCandidates,
  type MembersDialogIntent,
} from '@/layers/features/room-membership';
import { useFrozenReadCursor } from '../model/use-frozen-read-cursor';
import { useStickToBottom } from '../model/use-stick-to-bottom';
import { RoomComposer } from './RoomComposer';
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
  const stream = useRoomStream(roomId, entriesQuery.isSuccess);
  // Two of spec §14.3's three entry points are on this page — the header's
  // roster and the empty state — and both open the one panel the sidebar's row
  // menu opens. The fleet is read here rather than passed down, because this
  // page is on screen when the sidebar is a closed drawer; it is the same hook
  // the sidebar calls, so both get the same agents and the same answer about
  // whether the fleet could be read at all.
  const agents = useAgentPickerCandidates();
  const [membersIntent, setMembersIntent] = useState<MembersDialogIntent | null>(null);

  const room = roomQuery.data;
  const entries = useMemo(() => entriesQuery.data ?? [], [entriesQuery.data]);

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
  const frozenReadSeq = useFrozenReadCursor(roomId, lastReadSeq);
  useMarkRoomRead(room, entries);

  const newestEntryId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  const { scrollRef, onScroll } = useStickToBottom(roomId, newestEntryId);

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
        <RoomTimeline
          entries={[]}
          members={[]}
          lastReadSeq={null}
          isLoading
          error={null}
          onAddAgents={() => setMembersIntent('add')}
        />
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
      <RoomHeader room={room} onOpenMembers={() => setMembersIntent('roster')} />
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <RoomTimeline
          entries={entries}
          members={room.members}
          lastReadSeq={frozenReadSeq}
          isLoading={entriesQuery.isLoading}
          error={entriesQuery.error}
          onAddAgents={() => setMembersIntent('add')}
        />
      </div>
      {/* A room that has stopped listening looks exactly like a quiet one, so it
          has to say so. One line, no banner — you can still read and still post,
          and what you post still lands; you just would not see a reply. */}
      {stream.stalled && (
        <div
          role="status"
          className="text-muted-foreground flex items-center gap-2 border-t px-4 py-2 text-xs"
        >
          <span>New messages aren&apos;t coming through right now.</span>
          <button
            type="button"
            onClick={stream.retry}
            className="focus-ring hover:text-foreground rounded underline underline-offset-2"
          >
            Reconnect
          </button>
        </div>
      )}
      {/* Keyed on the room so opening a conversation gives you a composer that
          is focused and freshly sized for that room's draft. Switching to an
          already-read room takes none of the early returns above, so without
          this React reuses the instance and the input's own internals — focus,
          height, a part-typed IME composition — carry across. The DRAFT is safe
          either way; it belongs to the room, not to this element. */}
      <RoomComposer key={room.id} room={room} />

      {/* Mounted only while open: it reads the room itself, and a closed one
          would hold a roster from before the last change under it. */}
      {membersIntent !== null && (
        <RoomMembersDialog
          room={room}
          open
          onOpenChange={(next) => !next && setMembersIntent(null)}
          intent={membersIntent}
          agents={agents}
        />
      )}
    </div>
  );
}
