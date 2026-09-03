/**
 * One room as a command-palette row (spec `rooms` §13.2).
 *
 * @module features/command-palette/ui/RoomCommandItem
 */
import { CommandItem } from '@/layers/shared/ui';
import { RoomAvatar, RoomTitle, hasUnread, type RoomSummary } from '@/layers/entities/room';
import { ArchivedMark } from './ArchivedMark';
import { paletteRoomKeywords } from '../model/palette-rooms';

export interface RoomCommandItemProps {
  /** The room this row opens. */
  room: RoomSummary;
  /** Open the room. */
  onSelect: () => void;
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
 * The badge reads `unreadCount` strictly. `null` means "you are not in this
 * room", which is not `0` ("you are in it and caught up") — so a room the
 * operator has only ever looked at carries no badge rather than a zero.
 *
 * **An archived room says so**, in the same words a retired conversation does
 * ({@link ArchivedMark}).
 *
 * The row is named by its parts: the mark is decorative, the name contributes
 * `#general`, the badge contributes `3 unread`. Nothing names the room twice.
 */
export function RoomCommandItem({ room, onSelect }: RoomCommandItemProps) {
  const unread = hasUnread(room);

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
        <span className="min-w-0 flex-1 truncate text-sm">Open conversation with {room.title}</span>
      ) : (
        <RoomTitle room={room} className="min-w-0 flex-1 text-sm" />
      )}
      {room.archived && <ArchivedMark />}
      {unread && (
        <span
          className="bg-brand/15 text-brand text-3xs shrink-0 rounded-full px-1.5 py-0.5 font-medium tabular-nums"
          aria-label={`${room.unreadCount} unread`}
        >
          {room.unreadCount}
        </span>
      )}
    </CommandItem>
  );
}
