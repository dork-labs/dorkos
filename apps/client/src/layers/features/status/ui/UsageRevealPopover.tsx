import type { UsageStatus } from '@dorkos/shared/types';
import { Popover, PopoverAnchor, PopoverContent } from '@/layers/shared/ui';
import { UsageDetail, hasRenderableUsage } from './UsageStatusItem';

interface UsageRevealPopoverProps {
  /** The session's runtime-neutral usage descriptor, or null when none yet. */
  usage: UsageStatus | null;
  /** Whether the reveal is pinned open (driven by the `/context` intent). */
  open: boolean;
  /** Called when the popover requests a close (click-away, Escape). */
  onOpenChange: (open: boolean) => void;
}

/**
 * The pinned usage & cost reveal for the `/context` intent (DOR-109). A keyboard
 * user who types `/context` sees the same utilization + cost detail as the
 * status-bar item's hover tooltip, without hovering — identical on every runtime.
 * When the session has no usage yet (e.g. a cold Codex session), it shows an
 * honest empty state rather than a blank popover.
 *
 * Anchored to a zero-size span so it opens above the status bar regardless of
 * whether the (conditionally rendered) usage item is currently shown.
 */
export function UsageRevealPopover({ usage, open, onOpenChange }: UsageRevealPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span aria-hidden className="inline-block h-0 w-0" />
      </PopoverAnchor>
      <PopoverContent side="top" align="end" className="w-56" aria-label="Usage and cost">
        {usage != null && hasRenderableUsage(usage) ? (
          <UsageDetail usage={usage} />
        ) : (
          <p className="text-muted-foreground text-xs">No usage data for this session yet.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
