'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** How close to an edge still counts as having reached it. */
const EDGE_SLACK_PX = 1;

/**
 * A sideways-scrolling frame that fades its right edge only while content is
 * genuinely hidden there.
 *
 * macOS draws no scrollbar until you have already scrolled, so a region with
 * more to the right has to say so — and a region with nothing left to reach
 * must not (ADR 260725-004456). This mirrors the cockpit's `useScrollOverflow`
 * cue for the marketing site, which has no shared hook of its own.
 *
 * Only the right edge is cued. The left is pinned by the table's sticky row
 * header, which is its own signal that the view has moved.
 *
 * @param className - Classes for the scrolling element itself.
 * @param children - Content that may overflow sideways.
 */
export function HorizontalScrollFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hasMoreRight, setHasMoreRight] = useState(false);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const furthest = el.scrollWidth - el.clientWidth;
    setHasMoreRight(el.scrollLeft < furthest - EDGE_SLACK_PX);
  }, []);

  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Watch the children too: the table can change width without the frame doing so.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="relative">
      <div ref={scrollerRef} onScroll={measure} className={className}>
        {children}
      </div>
      {hasMoreRight && (
        <span
          aria-hidden
          data-testid="comparison-table-fade-end"
          className="from-cream-primary via-cream-primary/70 pointer-events-none absolute inset-y-px right-px w-8 rounded-r-lg bg-gradient-to-l to-transparent"
        />
      )}
    </div>
  );
}
