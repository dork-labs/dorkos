'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

interface RailArrowsProps {
  /** Nothing is hidden to the left. */
  atStart: boolean;
  /** Nothing is hidden to the right. */
  atEnd: boolean;
  /** Move the shelf one tile, in the direction given. */
  onNudge: (direction: 1 | -1) => void;
}

/**
 * The shelf's two arrows, for a mouse with no sideways scroll.
 *
 * They sit beside the section's heading rather than under the row, which is
 * where a shelf's controls belong: the dead space to the right of a short lede
 * is exactly their size, and putting them there keeps the row itself the last
 * thing on the band. Hidden below `sm`, where a finger is the control.
 *
 * Both go disabled at their end rather than scrolling into nothing, which is
 * how the pair doubles as a readout of whether there is more.
 */
export function RailArrows({ atStart, atEnd, onNudge }: RailArrowsProps) {
  const arrows = [
    { label: 'Previous clips', direction: -1 as const, Icon: ChevronLeft, spent: atStart },
    { label: 'Next clips', direction: 1 as const, Icon: ChevronRight, spent: atEnd },
  ];

  return (
    <div className="hidden gap-2 sm:flex">
      {arrows.map(({ label, direction, Icon, spent }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          disabled={spent}
          onClick={() => onNudge(direction)}
          className="grid size-9 cursor-pointer place-items-center rounded-full border transition-opacity disabled:cursor-default disabled:opacity-25"
          style={{ borderColor: 'rgba(255,255,255,0.16)', color: '#fffefb' }}
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
