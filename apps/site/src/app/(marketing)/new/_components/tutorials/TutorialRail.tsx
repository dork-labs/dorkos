'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { throttle } from 'lodash-es';
import { useReducedMotion } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TutorialCard } from './TutorialCard';
import { TutorialEndCard } from './TutorialEndCard';
import type { TutorialRailConfig } from './tutorials';

/** Past this much pointer travel a press is a drag, and the click it ends with is not a click. */
const DRAG_SLOP_PX = 5;

/** A pixel of slack at each end, because sub-pixel scroll positions never land exactly. */
const END_EPSILON_PX = 2;

/**
 * The horizontal row of tiles.
 *
 * Native overflow scrolling does the work, which is what gets swipe, momentum,
 * a real scrollbar for anyone who wants one, and keyboard reachability through
 * the cards' own controls for free. Three things are added on top.
 *
 * **Snap**, so a row of 9:16 frames comes to rest framed rather than halfway
 * through a tile.
 *
 * **Mouse drag**, because a rail on a desktop with a trackpad-less mouse is
 * otherwise reachable only by the arrows. It is mouse-only on purpose: touch
 * already drags, and hijacking touch would fight the browser's own momentum.
 * A press that travelled further than {@link DRAG_SLOP_PX} swallows the click
 * it ends with, so dragging across a tile never plays it.
 *
 * **An end-aware cue**, in two forms that answer the same question. The edge
 * of the band fades over whatever is under it while there is more that way,
 * and on a wide screen a pair of arrows says the same thing in a way you can
 * press. Both go quiet at the ends rather than lying about what is left.
 */
export function TutorialRail({ config }: { config: TutorialRailConfig }) {
  const railRef = useRef<HTMLUListElement>(null);
  const reduced = useReducedMotion();
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ startX: 0, startLeft: 0, moved: false });

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    setAtStart(rail.scrollLeft <= END_EPSILON_PX);
    setAtEnd(rail.scrollLeft >= max - END_EPSILON_PX);
  }, []);

  useEffect(() => {
    const onResize = throttle(measure, 150);
    window.addEventListener('resize', onResize, { passive: true });
    measure();
    return () => {
      window.removeEventListener('resize', onResize);
      onResize.cancel();
    };
  }, [measure]);

  /** Scroll by one tile, in the direction given. */
  const nudge = (direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    const step = rail.querySelector('li')?.getBoundingClientRect().width ?? rail.clientWidth * 0.8;
    rail.scrollBy({ left: direction * (step + 16), behavior: reduced ? 'auto' : 'smooth' });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLUListElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const rail = railRef.current;
    if (!rail) return;
    drag.current = { startX: event.clientX, startLeft: rail.scrollLeft, moved: false };

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - drag.current.startX;
      if (Math.abs(dx) > DRAG_SLOP_PX) {
        drag.current.moved = true;
        setDragging(true);
      }
      if (drag.current.moved) rail.scrollLeft = drag.current.startLeft - dx;
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="relative">
      <ul
        ref={railRef}
        aria-label={config.title}
        onScroll={measure}
        onPointerDown={onPointerDown}
        onClickCapture={(event) => {
          if (!drag.current.moved) return;
          drag.current.moved = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        className="flex [scrollbar-width:none] list-none gap-4 overflow-x-auto px-6 pb-2 [&::-webkit-scrollbar]:hidden"
        style={{
          // Snap has to stand down while a drag is in flight, or every frame of
          // the drag is fought by a scroll animation trying to re-centre a tile.
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

      {/* Edge cues. They sit over the rail and never take a press. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-10 transition-opacity duration-300"
        style={{
          opacity: atStart ? 0 : 1,
          background: 'linear-gradient(to right, #141210, transparent)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-14 transition-opacity duration-300"
        style={{
          opacity: atEnd ? 0 : 1,
          background: 'linear-gradient(to left, #141210, transparent)',
        }}
      />

      <div className="mt-6 hidden justify-end gap-2 px-6 sm:flex">
        {(
          [
            ['Previous clips', -1, ChevronLeft, atStart],
            ['Next clips', 1, ChevronRight, atEnd],
          ] as const
        ).map(([label, direction, Icon, spent]) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            disabled={spent}
            onClick={() => nudge(direction)}
            className="grid size-9 cursor-pointer place-items-center rounded-full border transition-opacity disabled:cursor-default disabled:opacity-30"
            style={{ borderColor: 'rgba(255,255,255,0.16)', color: '#fffefb' }}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
