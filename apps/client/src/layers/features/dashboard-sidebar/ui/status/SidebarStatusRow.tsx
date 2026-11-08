/**
 * One line of a list's state, drawn as a static sidebar row.
 *
 * @module features/dashboard-sidebar/ui/status/SidebarStatusRow
 */
import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  SIDEBAR_GLYPH_GAP,
  SIDEBAR_GLYPH_SLOT,
  SIDEBAR_ROW_INSET,
} from '@/layers/shared/ui';
import { ROW_GLYPH_CLASS } from '../row-glyph';

/** Props for {@link SidebarStatusRow}. */
export interface SidebarStatusRowProps {
  /** The words. */
  children: ReactNode;
  /** Draw the error glyph: something broke, rather than is on its way. */
  failed?: boolean;
  /** Offer "Try again" at the row's end. */
  onRetry?: () => void;
  /** Say it to a screen reader when it changes. A standing fact is not news. */
  live?: boolean;
}

/**
 * One line of a list's state — loading, offline, failed, empty — drawn as one
 * static row of the list it stands in for (Card §7, Phase 4 S13).
 *
 * The row's own height, inset and ink, with the words on the label column, so
 * a list that cannot show its rows still reads as part of the panel rather than
 * as a caption under it. A failure carries the error glyph in the glyph slot
 * and a ghost "Try again" at the end. Nothing here is pressable but that
 * button, and nothing moves. A space's channels and the Add-ons section both
 * draw it.
 *
 * @param props - The words, and whether it failed and can be retried.
 */
export function SidebarStatusRow({
  children,
  failed = false,
  onRetry,
  live = true,
}: SidebarStatusRowProps) {
  return (
    <div
      {...(live ? { role: 'status' } : {})}
      data-slot="sidebar-status-row"
      className={cn(
        'text-sidebar-foreground/70 text-control flex min-h-7 items-center rounded-md py-1 max-md:min-h-11',
        SIDEBAR_ROW_INSET
      )}
    >
      <span className={cn('flex shrink-0 items-center', SIDEBAR_GLYPH_SLOT)}>
        {failed && (
          <CircleAlert aria-hidden className={cn(ROW_GLYPH_CLASS, 'text-status-error-fg')} />
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', SIDEBAR_GLYPH_GAP)}>{children}</span>
      {onRetry && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onRetry}
          className="text-sidebar-foreground hover:bg-sidebar-accent/70 ml-2 shrink-0"
        >
          Try again
        </Button>
      )}
    </div>
  );
}
