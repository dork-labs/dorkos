import { Zap } from 'lucide-react';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { ControlCenterBody } from './ControlCenterBody';

/**
 * The Control Center — one always-present place to see and change the fleet's
 * power at a glance (spec `full-power-defaults`, D7).
 *
 * A persistent ⚡ glyph in the app chrome opens a flyout: a Popover on desktop, a
 * bottom drawer on small viewports (both from {@link ResponsivePopover}). The
 * open state lives in the app store, so the same flyout also opens from the
 * command-palette entry, the `mod+shift+l` shortcut, and the full-power consent
 * door's "Customize…" link — every one of them flips
 * `controlCenterOpen`.
 *
 * Mounted once by the app shell, in the top-bar fixed cluster beside the
 * command-palette trigger: the one spot present on every route and on both
 * desktop and mobile. (The sidebar header was the spec's candidate anchor, but
 * it is Home-tab-only on a phone; the fixed cluster is the honest "most visible,
 * always present" choice.)
 *
 * `modal`, because the flyout is a task — you change something and dismiss it —
 * not a glance. Escape and an outside click both close it.
 */
export function ControlCenter() {
  const open = useAppStore((s) => s.controlCenterOpen);
  const setOpen = useAppStore((s) => s.setControlCenterOpen);
  const isMobile = useIsMobile();

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen} modal>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-testid="control-center-trigger"
          aria-label="Control Center"
          className="focus-ring text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <Zap className="size-4" aria-hidden />
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="bottom"
        align="end"
        aria-label="Control Center"
        className="w-96 max-w-[calc(100vw-1.5rem)] p-3"
      >
        {/* Desktop shows a visible identity header; on mobile the drawer's own
            heading (below) does that job, so the header is skipped to avoid two
            titles. */}
        {!isMobile && (
          <header className="mb-3 flex items-center gap-2">
            <Zap className="text-status-success size-4 shrink-0" aria-hidden />
            <h2 className="text-sm font-semibold">Control Center</h2>
          </header>
        )}
        <ResponsivePopoverTitle>Control Center</ResponsivePopoverTitle>
        <ControlCenterBody />
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
