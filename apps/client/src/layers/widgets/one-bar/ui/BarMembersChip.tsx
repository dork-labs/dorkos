import { Users } from 'lucide-react';
import { useIsMobile } from '@/layers/shared/model';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface BarMembersChipProps {
  /** How many members the room has. */
  count: number;
  /** What the room is called, for the tooltip — the chip itself only counts. */
  roomName: string;
  /** Open the room's members. */
  onClick: () => void;
  /**
   * How many agents are working in the room, for the phone's dot.
   *
   * Read only below the mobile breakpoint, where the run-state chip is not drawn
   * at all (spec §4). `0` — and every wider viewport — draws nothing here.
   */
  working?: number;
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
export function BarMembersChip({ count, roomName, onClick, working = 0 }: BarMembersChipProps) {
  // **The same hook the run-state chip reads, and that pairing is the point.**
  // On a phone that chip is not drawn, so this one carries the signal; at every
  // wider viewport it IS drawn, so this one stays quiet and nothing is said
  // twice. A CSS breakpoint could not do this half of the job: the accessible
  // name below has to change with it, and no media query reaches an attribute.
  const isMobile = useIsMobile();
  const members = count === 1 ? '1 member' : `${count} members`;
  const busy = isMobile && working > 0;
  const workingLabel = working === 1 ? '1 agent working' : `${working} agents working`;
  const label = busy ? `${members}, ${workingLabel}` : members;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="bar-members-chip"
          onClick={onClick}
          aria-label={label}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring relative inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Users aria-hidden className="size-3.5" />
          {count}
          {busy && (
            /* The phone's whole run-state signal (spec §4) — a reduction for a
               narrow bar, not a second indicator competing with the chip that
               spells it out. Positioned rather than inline so it costs the chip
               no width and cannot nudge the name beside it. The words are not
               lost with the chip: they are in this button's accessible name. */
            <span
              aria-hidden
              data-testid="bar-members-working-dot"
              className="bg-status-success absolute top-0 right-0 size-1.5 rounded-full motion-safe:animate-pulse"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {busy ? `${members} in ${roomName} · ${workingLabel}` : `${members} in ${roomName}`}
      </TooltipContent>
    </Tooltip>
  );
}
