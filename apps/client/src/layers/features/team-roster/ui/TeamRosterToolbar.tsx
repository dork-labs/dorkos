import { Search, X } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Button, Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  teamMemberLabel,
  type TeamKindFilter,
  type TeamRosterFilters,
} from '@/layers/entities/team';

/** The three kind chips, in the order they are read. */
const KIND_CHIPS: { value: TeamKindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'people', label: 'People' },
  { value: 'agents', label: 'Agents' },
];

export interface TeamRosterToolbarProps {
  /** What the controls currently say. */
  filters: TeamRosterFilters;
  /** A partial update — the caller merges and re-renders (and, once routed, navigates). */
  onFiltersChange: (patch: Partial<TeamRosterFilters>) => void;
  /**
   * Everyone who can be filtered to — the people on the roster.
   *
   * A list, always, including when it holds one. The person chips appear once
   * there is more than one to choose between, because a single chip that
   * filters to the only person there is would be a control that does nothing;
   * on that install the owner filter is still reached by clicking a card or an
   * attribution, so nothing becomes unreachable.
   */
  people: TeamMember[];
  className?: string;
}

/**
 * The Team page's controls: what to show, whose, grouped how, matching what.
 *
 * Every control writes into one filter object, and that object is the shape
 * `/team`'s search params carry — so a roster someone narrowed is an address
 * they can send, and restoring it is reading the same fields back.
 *
 * The chip row scrolls sideways rather than wrapping: on a phone a wrapped row
 * of chips becomes three lines of chrome above two cards.
 */
export function TeamRosterToolbar({
  filters,
  onFiltersChange,
  people,
  className,
}: TeamRosterToolbarProps) {
  const owner = filters.owner ? people.find((person) => person.id === filters.owner) : undefined;

  return (
    <div className={cn('space-y-3', className)}>
      {/* The chips get the whole first line on a phone. Sharing it with the
          group toggle squeezed the scroller down to a chip and a half — a
          horizontal scroller nobody can tell is one. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Two groups sharing one scroller, not one group of two kinds: they
            answer different questions ("what am I looking at" vs "whose"), and
            a label covering both would name only one of them. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
          <div role="group" aria-label="Filter by kind" className="flex items-center gap-1.5">
            {KIND_CHIPS.map((chip) => (
              <Button
                key={chip.value}
                type="button"
                size="xs"
                variant={filters.kind === chip.value ? 'default' : 'outline'}
                aria-pressed={filters.kind === chip.value}
                onClick={() => onFiltersChange({ kind: chip.value })}
                className="shrink-0"
              >
                {chip.label}
              </Button>
            ))}
          </div>
          {/* One chip per person, once there is a choice to make. */}
          {people.length > 1 && (
            <div role="group" aria-label="Filter by person" className="flex items-center gap-1.5">
              {people.map((person) => (
                <Button
                  key={person.id}
                  type="button"
                  size="xs"
                  variant={filters.owner === person.id ? 'default' : 'outline'}
                  aria-pressed={filters.owner === person.id}
                  aria-label={`Show only ${person.displayName} and their agents`}
                  onClick={() =>
                    onFiltersChange({
                      owner: filters.owner === person.id ? undefined : person.id,
                    })
                  }
                  className="max-w-40 shrink-0 truncate"
                >
                  {teamMemberLabel(person)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant={filters.group === 'manager' ? 'default' : 'outline'}
            aria-pressed={filters.group === 'manager'}
            onClick={() =>
              onFiltersChange({ group: filters.group === 'manager' ? 'none' : 'manager' })
            }
            className="shrink-0"
          >
            {/* The value stays `manager` in code and on the wire; only the word
                a person reads changes. Everything else on /team says "owner"
                for the same idea, and nothing here ever explained "manager"
                (DOR-1755). */}
            Group by owner
          </Button>

          <div className="relative flex-1 sm:w-56 sm:flex-none">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            />
            <Input
              type="search"
              aria-label="Search the team"
              placeholder="Search"
              value={filters.q ?? ''}
              onChange={(event) =>
                onFiltersChange({ q: event.target.value === '' ? undefined : event.target.value })
              }
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      {/* The owner filter is also reachable by clicking a card or an
          attribution, so it needs a way back out that does not depend on a
          chip row that may not be drawn. */}
      {owner && (
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            Showing {teamMemberLabel(owner)} and their agents
          </p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onFiltersChange({ owner: undefined })}
          >
            <X aria-hidden className="size-3" />
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
