import type { CSSProperties } from 'react';
import { PanelResizeHandle, type PanelResizeHandleProps } from 'react-resizable-panels';

/** Props for {@link PaneResizeHandle}. */
export interface PaneResizeHandleProps extends Pick<
  PanelResizeHandleProps,
  'disabled' | 'onDragging' | 'id'
> {
  /** What the separator resizes, for a screen reader ("Resize thread"). */
  'aria-label'?: string;
  /** Test hook on the separator itself. */
  'data-testid'?: string;
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
 * at full strength.
 *
 * Keyboard and ARIA come from `react-resizable-panels`: the separator is a
 * focusable `role="separator"` with its current size as `aria-valuenow`, and
 * the arrow keys, Home and End resize it. Must be a child of a `PanelGroup`,
 * between the two `Panel`s it divides.
 *
 * @param props - What the handle resizes, and the strip's style.
 */
export function PaneResizeHandle({ gripStyle, ...handleProps }: PaneResizeHandleProps) {
  return (
    <PanelResizeHandle
      {...handleProps}
      // The strip is the whole visible affordance, so keyboard focus lights the
      // line rather than drawing a ring around a zero-width box.
      className="group relative outline-none"
      style={{ width: 0, overflow: 'visible' }}
    >
      <div
        className="absolute inset-y-0 -left-1 z-10 flex w-2 items-center justify-center"
        style={gripStyle}
      >
        <div className="group-hover:bg-ring/50 group-focus-visible:bg-ring h-full w-px transition-colors duration-500" />
      </div>
    </PanelResizeHandle>
  );
}
