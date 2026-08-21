import { Users } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface BarMembersChipProps {
  /** How many members the room has. */
  count: number;
  /** What the room is called, for the tooltip — the chip itself only counts. */
  roomName: string;
  /** Open the room's members. */
  onClick: () => void;
}

/**
 * Who is in the room, as one chip: a head count you can press.
 *
 * **A count, not a stack of faces.** The room masthead used to draw the roster
 * as overlapping avatars, which needs about 90px and a second row to breathe;
 * the bar has neither, and #team on this machine can hold 46 agents. A number is
 * the same fact in 40px, and it is the fact a person is actually after up here —
 * "who exactly" is a question the room panel answers once you press it.
 *
 * **Named by what it says, not by what it opens** (`aria-label="5 members"`).
 * The count is the content, so a screen reader that read only the label would
 * still hear it; the tooltip carries the room's name for the eye.
 */
export function BarMembersChip({ count, roomName, onClick }: BarMembersChipProps) {
  const label = count === 1 ? '1 member' : `${count} members`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="bar-members-chip"
          onClick={onClick}
          aria-label={label}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Users aria-hidden className="size-3.5" />
          {count}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {`${label} in ${roomName}`}
      </TooltipContent>
    </Tooltip>
  );
}
