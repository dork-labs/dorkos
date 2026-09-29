import type { ReactNode } from 'react';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { Popover, PopoverAnchor, PopoverContent, UsageBar } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { popoverWindowLabel } from '../lib/account-chip';
import { hasRenderableUsage, newestObservedAt, readableWindows } from '../lib/account-usage-status';
import { UsageCostRows, UsageDetail } from './UsageStatusItem';
import { UsageFreshnessLine } from './UsageFreshnessLine';

interface UsageRevealPopoverProps {
  /** The session's runtime-neutral usage descriptor, or null when none yet. */
  usage: UsageStatus | null;
  /**
   * The session's account's usage, or nothing when there is no reading. With a
   * readable window, the popover lists every window as a bar (spec
   * `claude-account-ui` §6.8).
   */
  accountUsage?: AccountUsage | null;
  /**
   * When {@link usage} was observed, ISO-8601, or nothing when that is not known.
   * Used for the freshness line when there are no account windows to date it.
   */
  observedAt?: string | null;
  /** Whether the reveal is pinned open (driven by the `/context` intent). */
  open: boolean;
  /** Called when the popover requests a close (click-away, Escape). */
  onOpenChange: (open: boolean) => void;
  /** A fixed moment to read reset and freshness times from (tests, Dev Playground); else the clock. */
  now?: Date;
}

/**
 * The pinned usage & cost reveal for the `/context` intent (DOR-109). A keyboard
 * user who types `/context` sees the same usage as the status-bar item, without
 * hovering — identical on every runtime. With an account reading it lists every
 * readable window as a bar ("reset" once a window's reset has passed); either
 * way it ends with how fresh the numbers are. When the session has no usage yet
 * (e.g. a cold Codex session), it shows an honest empty state rather than a
 * blank popover.
 *
 * Anchored to a zero-size span so it opens above the status bar regardless of
 * whether the (conditionally rendered) usage item is currently shown.
 */
export function UsageRevealPopover({
  usage,
  accountUsage = null,
  observedAt = null,
  open,
  onOpenChange,
  now: fixedNow,
}: UsageRevealPopoverProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  const windows = readableWindows(accountUsage);
  const freshness = windows.length > 0 ? newestObservedAt(windows) : observedAt;

  const hasUsage = usage != null && hasRenderableUsage(usage);
  let body: ReactNode;
  if (windows.length > 0) {
    body = (
      <div className="space-y-2">
        <div className="text-xs font-medium">Subscription usage</div>
        <div className="flex flex-col gap-2.5">
          {windows.map((window) => (
            <UsageBar
              key={window.key}
              window={window}
              label={popoverWindowLabel(window.key, window.label)}
              now={now}
            />
          ))}
        </div>
        {usage && (
          <div className="text-3xs space-y-0.5">
            <UsageCostRows usage={usage} />
          </div>
        )}
      </div>
    );
  } else if (hasUsage) {
    body = <UsageDetail usage={usage!} />;
  } else {
    body = <p className="text-muted-foreground text-xs">No usage data for this session yet.</p>;
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span aria-hidden className="inline-block h-0 w-0" />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        className="w-72 max-w-[calc(100vw-1.5rem)]"
        aria-label="Usage and cost"
      >
        <div className="space-y-2">
          {body}
          {freshness !== null && (windows.length > 0 || hasUsage) && (
            <UsageFreshnessLine observedAt={freshness} now={now} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
