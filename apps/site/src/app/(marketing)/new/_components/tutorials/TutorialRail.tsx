'use client';

import { TutorialCard } from './TutorialCard';
import { TutorialEndCard } from './TutorialEndCard';
import type { TutorialRailConfig } from './tutorials';
import type { RailHandlers } from './use-rail';

/** The band's own ground, so the edge fades dissolve into it rather than over it. */
const BAND_BASE = '#141210';

interface TutorialRailProps {
  config: TutorialRailConfig;
  /** Attach the scrolling element. */
  attachRail: (node: HTMLUListElement | null) => void;
  /** Scroll tracking, mouse drag, and the click a drag has to swallow. */
  handlers: RailHandlers;
  /** Nothing is hidden to the left. */
  atStart: boolean;
  /** Nothing is hidden to the right. */
  atEnd: boolean;
  /** A drag is in flight, so snap stands down. */
  dragging: boolean;
}

/**
 * The row of tiles, and the two fades at its ends.
 *
 * The mechanics live in `useRail`; this is the picture. What is worth knowing
 * here is the geometry: the row runs off the right edge of the screen rather
 * than stopping at the page's content column. Measured, not guessed — inside
 * the column, five tiles overflowed by 40px at 1440, which reads as a row that
 * happens to be slightly too wide. Bleeding to the viewport puts a tile visibly
 * cut by the edge of the screen, and a cut tile is the cue itself: structure,
 * rather than a gradient hinting at one. The bleed is zero below the width at
 * which the content column stops growing, so a phone is unaffected, and the
 * section clips it, so the page never scrolls sideways.
 *
 * The shelf's state arrives as separate values rather than as the one object
 * `useRail` returns. The React Compiler's `refs` rule cannot see inside a
 * custom hook, so it treats everything that comes out of one as possibly a
 * ref, and reading a plain boolean off it inside a `style` prop is then
 * reported as reading a ref during render. Plain props carry no such doubt.
 */
export function TutorialRail({
  config,
  attachRail,
  handlers,
  atStart,
  atEnd,
  dragging,
}: TutorialRailProps) {
  return (
    <div className="relative">
      <ul
        ref={attachRail}
        aria-label={config.title}
        {...handlers}
        className="mr-[calc(50%-50vw)] flex [scrollbar-width:none] list-none gap-4 overflow-x-auto px-6 pb-2 [&::-webkit-scrollbar]:hidden"
        style={{
          scrollSnapType: dragging ? 'none' : 'x mandatory',
          scrollPaddingInlineStart: '1.5rem',
          cursor: dragging ? 'grabbing' : 'grab',
        }}
      >
        {config.cards.map((card) => (
          <TutorialCard key={card.id} card={card} pendingChip={config.pendingChip} />
        ))}
        <TutorialEndCard endCard={config.endCard} />
      </ul>

      {/* Edge cues. They sit over the row and never take a press. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-10 transition-opacity duration-300"
        style={{
          opacity: atStart ? 0 : 1,
          background: `linear-gradient(to right, ${BAND_BASE}, transparent)`,
        }}
      />
      {/* Follows the row off the edge of the screen, so it fades the real end. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-[calc(50%-50vw)] w-14 transition-opacity duration-300"
        style={{
          opacity: atEnd ? 0 : 1,
          background: `linear-gradient(to left, ${BAND_BASE}, transparent)`,
        }}
      />
    </div>
  );
}
