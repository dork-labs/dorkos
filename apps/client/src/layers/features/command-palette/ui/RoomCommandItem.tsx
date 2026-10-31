/**
 * One room as a command-palette row (spec `rooms` §13.2).
 *
 * @module features/command-palette/ui/RoomCommandItem
 */
import { COUNT_PILL_CAP, CommandItem, CountPill, MENTION_COUNT_CAP } from '@/layers/shared/ui';
import { RoomAvatar, RoomTitle, type RoomSummary } from '@/layers/entities/room';
import { ArchivedMark } from './ArchivedMark';
import { paletteRoomKeywords } from '../model/palette-rooms';

export interface RoomCommandItemProps {
  /** The room this row opens. */
  room: RoomSummary;
  /** Open the room. */
  onSelect: () => void;
}

/** The count a palette row shows, and how it is read: only what was aimed at you. */
function directedCount(room: RoomSummary): { count: number; cap: number; label: string } | null {
  if (room.kind === 'dm') {
    const count = room.unreadCount ?? 0;
    if (count <= 0) return null;
    const amount = count > COUNT_PILL_CAP ? `More than ${COUNT_PILL_CAP}` : String(count);
    return {
      count,
      cap: COUNT_PILL_CAP,
      label: count === 1 ? '1 new message' : `${amount} new messages`,
    };
  }
  const count = room.mentionCount ?? 0;
  if (count <= 0 || room.unreadCount === null) return null;
  const amount = count > MENTION_COUNT_CAP ? `More than ${MENTION_COUNT_CAP}` : String(count);
  return {
    count,
    cap: MENTION_COUNT_CAP,
    label: count === 1 ? '1 mention' : `${amount} mentions`,
  };
}

/**
 * A room in the palette: its mark, its name, and an unread count when the
 * reader is behind.
 *
 * **A channel and a direct message are named differently on purpose.** A
 * channel is a place, so its row reads as the name you would type — `#general`
 * — and `RoomTitle` keeps the spoken `#` out of the visible text so the row
 * does not read `# #general` beside the mark that already draws it. A DM is a
 * conversation that already exists, so its row reads **"Open conversation with
 * Ana"**: typing `@ana` offers both that and the agent herself, and the two are
 * different things to do (spec `rooms` §13.2).
 *
 * It used to read "Message Ana", which promised a blank message this row does
 * not write — pressing it opens the existing conversation and shows you what is
 * already in it (spec `sidebar-simplification` §D2).
 *
 * **A number only for what was aimed at you**: a DM's new messages, or a
 * channel's mentions of you. A busy channel nobody addressed you in carries no
 * number, the sidebar's rule (AUDIT U6). `unreadCount` is read strictly: `null`
 * means "you are not in this room", which is not `0`. The count is solid,
 * because the wash drops to 4.04:1 on the palette's dark hover row.
 *
 * **An archived room says so**, in the same words a retired conversation does
 * ({@link ArchivedMark}).
 *
 * The row is named by its parts: the mark is decorative, the name contributes
 * `#general`, the count contributes `3 mentions`. Nothing names the room twice.
 */
export function RoomCommandItem({ room, onSelect }: RoomCommandItemProps) {
  const directed = directedCount(room);

  return (
    <CommandItem
      // The id, not the title: two rooms may share a title, and cmdk uses this
      // value as the row's identity for selection.
      value={room.id}
      keywords={paletteRoomKeywords(room)}
      onSelect={onSelect}
      className="flex items-center gap-2 py-2"
    >
      <RoomAvatar room={room} participants={room.participants} className="shrink-0" />
      {room.kind === 'dm' ? (
        <span className="min-w-0 flex-1 truncate text-sm">Open DM with {room.title}</span>
      ) : (
        <RoomTitle room={room} className="min-w-0 flex-1 text-sm" />
      )}
      {room.archived && <ArchivedMark />}
      {directed && (
        <CountPill solid count={directed.count} cap={directed.cap} label={directed.label} />
      )}
    </CommandItem>
  );
}
