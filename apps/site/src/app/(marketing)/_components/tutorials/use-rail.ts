'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { throttle } from 'lodash-es';
import { useReducedMotion } from 'motion/react';

/** Past this much pointer travel a press is a drag, and the click it ends with is not a click. */
const DRAG_SLOP_PX = 5;

/** A pixel of slack at each end, because sub-pixel scroll positions never land exactly. */
const END_EPSILON_PX = 2;

/** The gap between tiles, in pixels. Mirrors the row's `gap-4`. */
const TILE_GAP_PX = 16;

/**
 * Everything a horizontal shelf needs, so its row and its arrows can be siblings.
 *
 * The scrolling element arrives by callback ref rather than a `RefObject`, and
 * that is not a style preference. A shared object carrying a ref is ref-tainted
 * as far as the React Compiler's `refs` rule is concerned, so reading
 * `rail.atEnd` in a `style` prop — a plain boolean, nothing to do with the ref
 * — is reported as reading a ref during render. Handing back a function keeps
 * the element out of the shape entirely, and a callback ref is the better tool
 * here anyway: it fires on attach, which is when the first measurement is due.
 */
export interface Rail {
  /** Attach to the scrolling element. */
  attachRail: (node: HTMLUListElement | null) => void;
  /** Nothing is hidden to the left. */
  atStart: boolean;
  /** Nothing is hidden to the right. */
  atEnd: boolean;
  /** A mouse drag is in flight, so snap must stand down and the cursor closes. */
  dragging: boolean;
  /** Move one tile, in the direction given. */
  nudge: (direction: 1 | -1) => void;
  /** Spread onto the scrolling element: scroll tracking, drag, and click suppression. */
  railHandlers: RailHandlers;
}

/** What the scrolling element has to listen for. */
export interface RailHandlers {
  onScroll: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLUListElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLUListElement>) => void;
}

/**
 * The mechanics of a horizontally scrolling shelf.
 *
 * A hook rather than a component because the row and the arrows that drive it
 * belong in different places on the page — the arrows read best beside the
 * section's heading, where there is dead space, and the row runs off the right
 * edge of the screen below it. Two siblings cannot share a component's private
 * state, so the state moved out here and both read it.
 *
 * Native overflow scrolling does the actual work, which is what buys swipe,
 * momentum, a real scrollbar for anyone who wants one, and keyboard
 * reachability through the tiles' own controls. Three things are added.
 *
 * **Mouse drag**, because a shelf on a desktop with a wheel-only mouse is
 * otherwise reachable only by the arrows. Mouse-only on purpose: touch already
 * drags, and taking it over would fight the browser's own momentum. A press
 * that travelled further than {@link DRAG_SLOP_PX} swallows the click it ends
 * with, so dragging across a tile never plays it.
 *
 * **Snap standing down mid-drag**, or every frame of the drag is fought by a
 * scroll animation trying to re-centre a tile.
 *
 * **End awareness**, so the arrows and the edge fade go quiet at the ends
 * rather than implying there is more.
 */
export function useRail(): Rail {
  const railRef = useRef<HTMLUListElement | null>(null);
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

  const attachRail = useCallback(
    (node: HTMLUListElement | null) => {
      railRef.current = node;
      if (node) measure();
    },
    [measure]
  );

  useEffect(() => {
    const onResize = throttle(measure, 150);
    window.addEventListener('resize', onResize, { passive: true });
    measure();
    return () => {
      window.removeEventListener('resize', onResize);
      onResize.cancel();
    };
  }, [measure]);

  const nudge = useCallback(
    (direction: 1 | -1) => {
      const rail = railRef.current;
      if (!rail) return;
      const tile =
        rail.querySelector('li')?.getBoundingClientRect().width ?? rail.clientWidth * 0.8;
      rail.scrollBy({
        left: direction * (tile + TILE_GAP_PX),
        behavior: reduced ? 'auto' : 'smooth',
      });
    },
    [reduced]
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLUListElement>) => {
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
  }, []);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLUListElement>) => {
    if (!drag.current.moved) return;
    drag.current.moved = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    attachRail,
    atStart,
    atEnd,
    dragging,
    nudge,
    railHandlers: { onScroll: measure, onPointerDown, onClickCapture },
  };
}
