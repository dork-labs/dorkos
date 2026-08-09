/**
 * One room as a command-palette row (spec `rooms` §13.2).
 *
 * @module features/command-palette/ui/RoomCommandItem
 */
import { CommandItem } from '@/layers/shared/ui';
import { RoomAvatar, RoomTitle, hasUnread, type RoomSummary } from '@/layers/entities/room';
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
 * does not read `# #general` beside the mark that already draws it. A DM is not
 * a place but an act, so its row reads **"Message Ana"**: typing `@ana` offers
 * both that and the agent herself, and the two are different things to do
 * (spec `rooms` §13.2).
 *
 * The badge reads `unreadCount` strictly. `null` means "you are not in this
 * room", which is not `0` ("you are in it and caught up") — so a room the
 * operator has only ever looked at carries no badge rather than a zero.
 *
 * **An archived room says so.** The palette is the only surface that lists one
 * at all (DOR-1051), so nothing else on screen explains why a channel you
 * thought was closed is in front of you. The word is plain text rather than a
 * badge with a hidden label: it is part of what the row is called, and a person
 * skimming a search result needs it in the same glance as the name.
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
        <span className="min-w-0 flex-1 truncate text-sm">Message {room.title}</span>
      ) : (
        <RoomTitle room={room} className="min-w-0 flex-1 text-sm" />
      )}
      {room.archived && (
        <span className="text-muted-foreground border-border shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
          Archived
        </span>
      )}
      {unread && (
        <span
          className="bg-brand/15 text-brand shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
          aria-label={`${room.unreadCount} unread`}
        >
          {room.unreadCount}
        </span>
      )}
    </CommandItem>
  );
}
