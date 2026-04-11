import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Transition } from 'motion/react';
import { cn } from '@/layers/shared/lib';

/** @internal StatusLine compound component context. Not part of the public API. */
interface StatusLineContextValue {
  /** Shared animation transition applied to all items. */
  itemTransition: Transition;
  /** The itemKey of the first currently-registered visible item, or null if none. */
  firstVisibleKey: string | null;
  /** Called by StatusLine.Item via useEffect on mount when visible. */
  registerItem: (key: string) => void;
  /** Called by StatusLine.Item via useEffect cleanup on unmount or when visible becomes false. */
  unregisterItem: (key: string) => void;
}

const StatusLineContext = React.createContext<StatusLineContextValue | null>(null);

/**
 * Access the StatusLine registration context. Throws if called outside a StatusLine provider.
 *
 * @internal Use within StatusLine.Item only.
 */
function useStatusLineContext(): StatusLineContextValue {
  const ctx = React.useContext(StatusLineContext);
  if (!ctx) {
    throw new Error('StatusLine.Item must be used within a StatusLine.');
  }
  return ctx;
}

const ITEM_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

interface StatusLineProps {
  /** Session identifier. Passed for future use (e.g., ARIA labeling). */
  sessionId: string;
  /** Whether the session is currently streaming. May affect item logic in future extensions. */
  isStreaming: boolean;
  /** StatusLine.Item elements. */
  children: React.ReactNode;
}

function StatusLineRoot({
  sessionId: _sessionId,
  isStreaming: _isStreaming,
  children,
}: StatusLineProps) {
  const [registeredKeys, setRegisteredKeys] = useState<string[]>([]);

  const registerItem = useCallback((key: string) => {
    // Guard against duplicate registration on StrictMode double-invoke
    setRegisteredKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  const unregisterItem = useCallback((key: string) => {
    setRegisteredKeys((prev) => prev.filter((k) => k !== key));
  }, []);

  // Insertion-order first key is the first visible item — stable across re-renders
  // because items are not conditionally reordered in JSX, only visibility changes
  const firstVisibleKey = registeredKeys[0] ?? null;
  // Container shows when at least one item is registered (visible)
  const hasVisibleChildren = registeredKeys.length > 0;

  const contextValue = useMemo<StatusLineContextValue>(
    () => ({
      itemTransition: ITEM_TRANSITION,
      firstVisibleKey,
      registerItem,
      unregisterItem,
    }),
    [firstVisibleKey, registerItem, unregisterItem]
  );

  return (
    <StatusLineContext.Provider value={contextValue}>
      {/*
       * Outer AnimatePresence: animates the entire status bar container in/out.
       * Inner AnimatePresence (mode="popLayout"): animates individual items.
       * This two-boundary architecture is preserved from the original implementation.
       *
       * Children are always mounted so that StatusLine.Item useEffect hooks
       * can register/unregister with the context regardless of container
       * visibility. Items with visible=false return null, so they contribute
       * no DOM nodes but their effects still run to drive registration state.
       */}
      <AnimatePresence initial={false}>
        {hasVisibleChildren && (
          <motion.div
            role="toolbar"
            aria-label="Session status"
            aria-live="polite"
            data-testid="status-line"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <StatusLineScroller>
              <AnimatePresence initial={false} mode="popLayout">
                {React.Children.map(children, (child) => {
                  if (!React.isValidElement(child)) return child;
                  const itemKey = (child.props as { itemKey?: string }).itemKey;
                  return itemKey ? React.cloneElement(child, { key: itemKey }) : child;
                })}
              </AnimatePresence>
            </StatusLineScroller>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Mount children unconditionally when container is hidden so item effects can fire */}
      {!hasVisibleChildren && children}
    </StatusLineContext.Provider>
  );
}

interface StatusLineItemProps {
  /**
   * Stable unique identifier used for AnimatePresence tracking and separator logic.
   * Must be unique within the StatusLine. Use short lowercase slugs: 'cwd', 'git', etc.
   */
  itemKey: string;
  /** Controls whether this item participates in the status bar. */
  visible: boolean;
  /** The status item content — one of the 9 built-in item components or a plugin element. */
  children: React.ReactNode;
}

function StatusLineItem({ itemKey, visible, children }: StatusLineItemProps) {
  const { itemTransition, firstVisibleKey, registerItem, unregisterItem } = useStatusLineContext();

  /*
   * Register with root context when visible; deregister on unmount or when visibility
   * is lost. useEffect (not render-time logic) is the correct primitive — this ensures
   * the root state updates after commit, not during render.
   */
  useEffect(() => {
    if (!visible) return;
    registerItem(itemKey);
    return () => unregisterItem(itemKey);
  }, [visible, itemKey, registerItem, unregisterItem]);

  // Returning null triggers AnimatePresence to fire the exit animation for this key.
  if (!visible) return null;

  const isFirst = itemKey === firstVisibleKey;

  return (
    <motion.div
      key={itemKey}
      layout="position"
      initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
      transition={itemTransition}
      className="inline-flex items-center gap-2"
    >
      {/* Separator exits with this item during AnimatePresence — no orphaned separators */}
      {!isFirst && <StatusLineSeparator />}
      {children}
    </motion.div>
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
 * Horizontally scrollable container for status items.
 *
 * Shows a right-edge fade gradient when content overflows, hinting that
 * more items are available. Hides the scrollbar for a clean appearance.
 *
 * @internal
 */
function StatusLineScroller({ children }: { children: React.ReactNode }) {
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
    <div className="relative">
      <div
        ref={scrollRef}
        className="text-muted-foreground scrollbar-none flex items-center gap-2 overflow-x-auto px-1 text-xs whitespace-nowrap"
      >
        {children}
      </div>
      {/* Right fade gradient — hints at scrollable overflow */}
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

/**
 * StatusLine compound component — animated session status bar.
 *
 * Renders a horizontal toolbar containing `StatusLine.Item` children.
 * Items animate in and out individually via Motion's AnimatePresence.
 * The container fades in when the first item becomes visible and fades
 * out when the last item disappears.
 *
 * Data fetching is the responsibility of the consumer. Pass pre-fetched
 * data to individual item components via StatusLine.Item children.
 *
 * @example
 * ```tsx
 * <StatusLine sessionId={id} isStreaming={streaming}>
 *   <StatusLine.Item itemKey="cwd" visible={showCwd && !!cwd}>
 *     <CwdItem cwd={cwd} />
 *   </StatusLine.Item>
 *   <StatusLine.Item itemKey="git" visible={showGit}>
 *     <GitStatusItem data={gitStatus} />
 *   </StatusLine.Item>
 * </StatusLine>
 * ```
 */
export const StatusLine = Object.assign(StatusLineRoot, {
  Item: StatusLineItem,
});
