/**
 * The slide a to-do row makes when a Reorder button moves it (DOR-3715). dnd-kit slides rows only
 * during a drag, so a move with nothing dragged would swap rows in a single frame. This measures
 * where every row is drawn just before the move, and once the new order is laid out, before the
 * browser paints, plays each moved row from its old place to its new one.
 *
 * A press during a slide retargets it: the next slide starts from where the row is on screen at
 * that moment, read from the slide still playing, so it neither jumps nor steps back. Under
 * reduced motion it does nothing, and a move is instant.
 *
 * @module features/todos/model/use-row-slide
 */
import { useCallback, useLayoutEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';

/** The slide: short, and with no overshoot. */
const SLIDE: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(0, 0, 0.2, 1)' };

/** How far a playing slide has the row from its place right now, in pixels. */
function slidOffset(row: HTMLElement): number {
  const transform = getComputedStyle(row).transform;
  return transform && transform !== 'none' ? new DOMMatrix(transform).m42 : 0;
}

/** Each lifted row's latest slide: a slide a retarget replaced must not settle the new one. */
const liftedBy = new WeakMap<HTMLElement, Animation>();

/** A dragged row's look (`TodoRow`'s `dragging`), held for one slide. */
function lift(row: HTMLElement, slide: Animation) {
  liftedBy.set(row, slide);
  row.style.position = 'relative';
  row.style.zIndex = '10';
  row.style.backgroundColor = 'var(--color-card)';
  row.style.boxShadow = 'var(--shadow-sm)';
  const settle = () => {
    // A cancelled slide reports after the slide that replaced it began.
    if (liftedBy.get(row) !== slide) return;
    liftedBy.delete(row);
    row.style.position = '';
    row.style.zIndex = '';
    row.style.backgroundColor = '';
    row.style.boxShadow = '';
  };
  slide.onfinish = settle;
  slide.oncancel = settle;
}

/** Every row the list draws, by to-do id. */
function rowsById(): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const row of document.querySelectorAll<HTMLElement>('[data-todo-row-id]')) {
    const id = row.dataset.todoRowId;
    if (id) rows.set(id, row);
  }
  return rows;
}

/**
 * Slide rows to their new places after a move.
 *
 * @param order - The order the list draws, which changes when a move lands.
 * @returns `measure()`, to call just before a move.
 */
export function useRowSlide(order: unknown): { measure: () => void } {
  const reducedMotion = useReducedMotion() === true;
  const before = useRef<Map<string, number> | null>(null);

  const measure = useCallback(() => {
    if (reducedMotion) return;
    // Each row's place, not where a slide has it: the slide's own offset is read again later.
    const tops = new Map<string, number>();
    for (const [id, row] of rowsById()) {
      tops.set(id, row.getBoundingClientRect().top - slidOffset(row));
    }
    before.current = tops;
  }, [reducedMotion]);

  useLayoutEffect(() => {
    const tops = before.current;
    if (!tops) return;
    before.current = null;
    for (const [id, row] of rowsById()) {
      const place = tops.get(id);
      if (place === undefined) continue;
      // No Web Animations (a test's DOM): the move is instant.
      if (typeof row.animate !== 'function') continue;
      // Where the row is drawn now: its old place plus the slide still playing, read before that
      // slide is stopped. Then the distance to its new place, measured with nothing playing.
      const from = place + slidOffset(row);
      for (const animation of row.getAnimations?.() ?? []) animation.cancel();
      const dy = from - row.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      const slide = row.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        SLIDE
      );
      // The row being moved, which holds focus, lifts while it slides, as a dragged row does:
      // solid and over the row it trades places with, so their words never show through.
      if (row.contains(document.activeElement)) lift(row, slide);
    }
  }, [order]);

  return { measure };
}
