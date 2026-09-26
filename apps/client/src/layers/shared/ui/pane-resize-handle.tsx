import type { CSSProperties } from 'react';
import { PanelResizeHandle, type PanelResizeHandleProps } from 'react-resizable-panels';
import { cn } from '@/layers/shared/lib/utils';

/** The keys `react-resizable-panels` resizes a separator with. */
const RESIZE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Props for {@link PaneResizeHandle}. */
export interface PaneResizeHandleProps extends Pick<
  PanelResizeHandleProps,
  'disabled' | 'onDragging' | 'id' | 'onKeyDownCapture'
> {
  /** What the separator resizes, for a screen reader ("Resize thread"). */
  'aria-label': string;
  /** Test hook on the separator itself. */
  'data-testid'?: string;
  /**
   * Called once a person has finished resizing: when a drag lets go, and after
   * each key that moved the separator.
   *
   * The moment to remember a width the person CHOSE. The library also moves
   * panes on its own — clamping them when the window or a neighbour squeezes
   * the group — and a size saved from those moves would overwrite the one the
   * person set with whatever the squeeze left behind.
   */
  onResizeEnd?: () => void;
  /**
   * Inline style for the grab strip inside the separator.
   *
   * The right panel fades its strip with the panel it belongs to and keeps it
   * mounted while closed, so it needs to drive opacity and pointer events from
   * the outside; a handle that is only ever mounted beside an open pane passes
   * nothing.
   */
  gripStyle?: CSSProperties;
}

/**
 * The hairline between two side-by-side panes that you drag to resize them.
 *
 * One component for every split in the app so they all feel the same: a
 * zero-width separator whose 8px grab strip straddles the pane border, and a
 * 1px line that warms to the focus-ring colour on hover. The border itself
 * belongs to the pane beside it (`border-l`), so the handle draws nothing at
 * rest and never adds width to the layout. Keyboard focus lights the same line
 * at full strength, at once — a focus indicator that fades in is one a reader
 * tabbing past never sees.
 *
 * Keyboard and ARIA come from `react-resizable-panels`: the separator is a
 * focusable `role="separator"` with its current size as `aria-valuenow`, and
 * the arrow keys, Home and End resize it. A disabled handle leaves the tab
 * order and says it is disabled, so a separator that cannot move is never a
 * stop that does nothing. Must be a child of a `PanelGroup`, between the two
 * `Panel`s it divides.
 *
 * @param props - What the handle resizes, and the strip's style.
 */
export function PaneResizeHandle({
  gripStyle,
  onDragging,
  onResizeEnd,
  disabled = false,
  ...handleProps
}: PaneResizeHandleProps) {
  const handleKeyDown = (event: { key: string }) => {
    // The library resizes on the element's own listener, which has already run
    // by the time React delivers this — so the new size is in place.
    if (!disabled && RESIZE_KEYS.has(event.key)) onResizeEnd?.();
  };

  return (
    <PanelResizeHandle
      {...handleProps}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onDragging={(dragging) => {
        onDragging?.(dragging);
        if (!dragging) onResizeEnd?.();
      }}
      onKeyDown={handleKeyDown}
      // The strip is the whole visible affordance, so keyboard focus lights the
      // line rather than drawing a ring around a zero-width box.
      className="group relative outline-none"
      style={{ width: 0, overflow: 'visible' }}
    >
      <div
        className="absolute inset-y-0 -left-1 z-10 flex w-2 items-center justify-center"
        style={gripStyle}
      >
        <div
          data-slot="pane-resize-line"
          className={cn(
            'h-full w-px transition-colors duration-500',
            !disabled &&
              'group-hover:bg-ring/50 group-focus-visible:bg-ring group-focus-visible:transition-none'
          )}
        />
      </div>
    </PanelResizeHandle>
  );
}
