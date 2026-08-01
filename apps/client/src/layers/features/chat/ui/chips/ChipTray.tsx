/**
 * The chip tray — the turn's full roster, behind the summary line's disclosure.
 *
 * @module features/chat/ui/chips/ChipTray
 */
import { useMemo, useState } from 'react';
import { cn } from '@/layers/shared/lib';
import { SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import type { TouchChip as TouchChipData, TouchChipVerb } from '../../lib/touch-chips';
import { TouchChip } from './TouchChip';
import { groupChipsByVerb, VERB_ICON, VERB_LABEL, VERB_ORDER } from './chip-verbs';

/** How the roster is sorted: grouped by what happened, or in the order it happened. */
export type ChipOrder = 'grouped' | 'chronological';

export interface ChipTrayProps {
  /** DOM id, so the disclosure button that opens the tray can point `aria-controls` at it. */
  id?: string;
  /** The turn's full deduplicated roster. */
  chips: TouchChipData[];
  /** Open a chip's target. */
  onOpen: (chip: TouchChipData) => void;
}

/** Position of each verb in the canonical reading order, for the grouped sort. */
const VERB_RANK = new Map(VERB_ORDER.map((verb, index) => [verb, index]));

/**
 * Sort a roster for display. Neither order re-derives anything — both are views
 * over the same accumulated chips.
 *
 * Exported so the order the tray actually ships is the order under test. A
 * comparator written out again in a test file stays green while this one
 * changes, which is a test of nothing.
 *
 * @param chips - The roster to order, left as it was.
 * @param order - Grouped by verb, or in the order the turn touched things.
 * @returns A new array in the requested order.
 */
export function sortChips(chips: TouchChipData[], order: ChipOrder): TouchChipData[] {
  const sorted = [...chips];
  if (order === 'chronological') {
    return sorted.sort((a, b) => a.lastSeq - b.lastSeq);
  }
  return sorted.sort(
    (a, b) => (VERB_RANK.get(a.verb) ?? 0) - (VERB_RANK.get(b.verb) ?? 0) || a.firstSeq - b.firstSeq
  );
}

/**
 * The full roster of what a turn touched: filterable by what happened to it,
 * sortable by kind or by when it happened, and bounded so it scrolls itself
 * rather than growing the transcript.
 *
 * Both the filter and the order are plain component state. They are a way of
 * looking at this one turn, not a preference worth carrying to the next one.
 *
 * @param props - The roster, an open handler, and the id its disclosure points at.
 */
export function ChipTray({ id, chips, onOpen }: ChipTrayProps) {
  const [verbFilter, setVerbFilter] = useState<TouchChipVerb | null>(null);
  const [order, setOrder] = useState<ChipOrder>('grouped');

  // Counted over the whole roster, so a filter narrows the list without making
  // the other counts move under the cursor that is about to click them.
  const groups = useMemo(() => groupChipsByVerb(chips), [chips]);

  const visible = useMemo(() => {
    const filtered = verbFilter ? chips.filter((chip) => chip.verb === verbFilter) : chips;
    return sortChips(filtered, order);
  }, [chips, verbFilter, order]);

  return (
    <div
      id={id}
      role="region"
      aria-label="Touched files and links"
      data-testid="chip-tray"
      className="border-border bg-card/50 flex flex-col gap-2 rounded-md border p-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Filter by what happened" className="flex flex-wrap gap-1">
          {groups.map((group) => {
            const active = verbFilter === group.verb;
            return (
              <button
                key={group.verb}
                type="button"
                aria-pressed={active}
                data-testid={`chip-filter-${group.verb}`}
                onClick={() => setVerbFilter(active ? null : group.verb)}
                className={cn(
                  // Bordered whether or not it is on, so the row reads as a set
                  // of controls rather than as a line of text that turns out to
                  // be clickable. The active one takes the accent border.
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                  'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                <span aria-hidden="true">{VERB_ICON[group.verb]}</span>
                <span className="sr-only">{VERB_LABEL[group.verb]}</span>
                <span className="tabular-nums">{group.chips.length}</span>
              </button>
            );
          })}
        </div>
        <SegmentedControl
          value={order}
          onValueChange={(next) => setOrder(next as ChipOrder)}
          aria-label="Order the roster"
          className="w-auto"
        >
          {/* "Grouped", not "Kind": this groups by what HAPPENED to a target,
              and a chip's kind is the different question of file-vs-link-vs-command. */}
          <SegmentedControlItem value="grouped">Grouped</SegmentedControlItem>
          <SegmentedControlItem value="chronological">Chronological</SegmentedControlItem>
        </SegmentedControl>
      </div>
      {/* Bounded and self-scrolling: the tray never grows the transcript's own
          scroll height, however much a turn touched. `overscroll-contain` is
          what keeps it from handing the scroll back — without it, reaching the
          bottom of the roster carries on into the transcript, which jumps the
          tray out from under the cursor that was reading it. */}
      <div
        data-testid="chip-tray-roster"
        className="flex max-h-60 flex-wrap items-start gap-1.5 overflow-y-auto overscroll-contain"
      >
        {visible.map((chip) => (
          <TouchChip key={chip.key} chip={chip} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
