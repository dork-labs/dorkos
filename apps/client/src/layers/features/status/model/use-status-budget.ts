/**
 * Measure the status bar and turn its width into a budget.
 *
 * @module features/status/model/use-status-budget
 */
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { resolveStatusBudget, type StatusBudget } from './status-budget';

/** What {@link useStatusBudget} hands back. */
export interface MeasuredStatusBudget {
  /** Attach to the bar container — the element whose width the budget is drawn from. */
  ref: RefObject<HTMLDivElement | null>;
  /** What the measured width affords. */
  budget: StatusBudget;
}

/**
 * Observe the bar container and resolve what its real width affords.
 *
 * One `ResizeObserver`, on the element that actually holds the line — the same
 * observation the old right-edge fade gradient used, now answering a question
 * worth asking. It catches everything a media query cannot: browser zoom, Dynamic
 * Type, the sidebar opening, a resized desktop window, and the difference between
 * a 767px tablet and a 320px phone.
 *
 * The observed element must be a block that fills its parent, never one sized by
 * its own content, or trimming the line would shrink the box that decides how much
 * the line may hold.
 */
export function useStatusBudget(): MeasuredStatusBudget {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Seed synchronously so the first committed frame is already measured; a real
    // ResizeObserver then fires after layout and before paint, so nothing flashes.
    setWidth(el.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(0);
      if (!entry) return;
      const inlineSize = entry.contentBoxSize?.at(0)?.inlineSize ?? entry.contentRect.width;
      setWidth(inlineSize);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const budget = useMemo(() => resolveStatusBudget(width), [width]);
  return { ref, budget };
}
