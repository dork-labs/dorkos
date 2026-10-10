import { roomLead, type RoomLeadInput } from '@/layers/entities/room';
import { openRoomPanel } from '@/layers/features/room-management';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface RoomLeadChipProps {
  /** The room, with its roster read, as the caller already holds it. */
  room: RoomLeadInput & { id: string };
}

/**
 * Who leads the channel, quietly, in the bar (DOR-2823).
 *
 * **Text, not a badge.** The lead is a fact about the room, not a state that
 * needs attention, so it sits in the same muted register as the head count
 * beside it — "Lead Kai" — and draws nothing at all when the channel has no
 * lead or is a direct message.
 *
 * **Only on a wide window.** Below `lg` the bar spends its width on the room's
 * name and the controls (on a tablet with a large team the chip pushed them out
 * of the bar); the room panel's roster still wears the Lead badge.
 *
 * Pressing it opens the roster in the room panel, the same door the head count
 * opens, because that is where the lead is changed.
 */
export function RoomLeadChip({ room }: RoomLeadChipProps) {
  const lead = roomLead(room);
  if (lead === null) return null;
  const name = lead.author.displayName;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="bar-lead-chip"
          onClick={() => openRoomPanel('members', room.id)}
          aria-label={`Lead: ${name}`}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring hidden h-6 max-w-40 min-w-0 shrink items-center gap-1 rounded-full px-2 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none lg:inline-flex"
        >
          <span className="shrink-0">Lead</span>
          <span className="text-foreground/80 truncate font-medium">{name}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {`${name} answers messages nobody else is answering.`}
      </TooltipContent>
    </Tooltip>
  );
}
