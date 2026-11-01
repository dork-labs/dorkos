/**
 * The ink and size the sidebar's own row glyphs wear.
 *
 * @module features/dashboard-sidebar/ui/row-glyph
 */
import { cn } from '@/layers/shared/lib';
import { SIDEBAR_ICON_CONTROL, SIDEBAR_ICON_INLINE } from '@/layers/shared/ui';

/**
 * A row's leading glyph: a channel's `#`, Threads, Directory, a contributed
 * door. Control-sized, in the same ink as a quiet row's label.
 */
export const ROW_GLYPH_CLASS = cn('text-sidebar-foreground/70 shrink-0', SIDEBAR_ICON_CONTROL);

/**
 * Mute and pause: quiet marks after a name. `/60` rather than the `/50` they
 * wore, which passed 3:1 with almost nothing to spare (Phase 4 P8).
 */
export const ROW_QUIET_MARK_CLASS = cn('text-sidebar-foreground/60 shrink-0', SIDEBAR_ICON_INLINE);
