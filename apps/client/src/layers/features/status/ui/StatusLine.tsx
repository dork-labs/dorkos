import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { PromotedStatusItem } from '../model/promoted-items';

const ITEM_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

interface StatusLineProps {
  /**
   * The items to show, already promoted and in order. Visibility is decided
   * upstream by `selectPromotedItems`, so this component never asks whether an
   * item belongs — it draws what it is given.
   */
  items: readonly PromotedStatusItem[];
  /**
   * The fixed trailing anchor — the Session `⋯`. Rendered outside the scrolling
   * region so it is always reachable, always last, and never dropped.
   */
  trailing?: ReactNode;
}

/**
 * The composer status line — one row, two clusters.
 *
 * Left is who and where; right is state and numbers. A single flexible gap
 * separates them, and separators only ever sit *between* items inside a cluster,
 * so no middot is ever left floating in the gap.
 *
 * @param props - The promoted items and the trailing anchor.
 */
export function StatusLine({ items, trailing }: StatusLineProps) {
  const left = items.filter((item) => item.cluster === 'left');
  const right = items.filter((item) => item.cluster === 'right');

  return (
    <div
      role="toolbar"
      aria-label="Session status"
      aria-live="polite"
      data-testid="status-line"
      className="text-muted-foreground flex items-center gap-2 text-xs"
    >
      <StatusLineScroller>
        <StatusCluster items={left} className="min-w-0 flex-1" />
        <StatusCluster items={right} />
      </StatusLineScroller>
      {trailing}
    </div>
  );
}

/**
 * One cluster of items. Separator placement is derived from position in the
 * *visible* list, so an item that hides and comes back can never reappear
 * carrying a leading separator.
 *
 * @internal
 */
function StatusCluster({
  items,
  className,
}: {
  items: readonly PromotedStatusItem[];
  className?: string;
}) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((item, index) => (
          <motion.div
            key={item.key}
            data-testid={`status-item-${item.key}`}
            layout="position"
            initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
            transition={ITEM_TRANSITION}
            className="inline-flex items-center gap-2"
          >
            {index > 0 && <StatusLineSeparator />}
            {item.node}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Middot separator between status items.
 *
 * @internal
 */
function StatusLineSeparator() {
  return (
    <span className="text-muted-foreground/30" aria-hidden="true">
      &middot;
    </span>
  );
}

/**
 * The measured region of the line: the two clusters, with a right-edge fade when
 * their content is wider than the space available.
 *
 * @internal
 */
function StatusLineScroller({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Allow 1px tolerance for sub-pixel rounding
    setCanScrollRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    checkOverflow();

    el.addEventListener('scroll', checkOverflow, { passive: true });

    // ResizeObserver catches layout changes (items added/removed, viewport resize)
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', checkOverflow);
      ro.disconnect();
    };
  }, [checkOverflow]);

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollRef}
        className="flex scrollbar-none items-center gap-2 overflow-x-auto px-1 whitespace-nowrap"
      >
        {children}
      </div>
      {/* Right fade gradient — hints at content wider than the row */}
      <div
        className={cn(
          'from-background pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l to-transparent transition-opacity duration-200',
          canScrollRight ? 'opacity-100' : 'opacity-0'
        )}
        aria-hidden
      />
    </div>
  );
}
