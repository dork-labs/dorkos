import { Gauge, DollarSign } from 'lucide-react';
import type { UsageStatus } from '@dorkos/shared/types';
import { DetailRow, Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { formatCost } from '../lib/format-tokens';

interface UsageStatusItemProps {
  usage: UsageStatus;
}

/**
 * Whether a {@link UsageStatus} has a metric worth rendering. A subscription
 * renders when it has utilization or cost; pay-as-you-go renders when it has
 * cost. The parent gates its mount on this so an empty usage hides the item.
 *
 * @param usage - The runtime-neutral usage descriptor.
 */
export function hasRenderableUsage(usage: UsageStatus): boolean {
  if (usage.kind === 'subscription') {
    return usage.utilization != null || usage.costUsd != null;
  }
  return usage.costUsd != null;
}

/**
 * The usage & cost detail body — utilization, window, resets, and cost for a
 * subscription; the cost figure for pay-as-you-go. Shared by the status-bar
 * item's hover tooltip and the pinned `/context` reveal so both read identically
 * (DOR-100 / DOR-109). Render only for a usage that {@link hasRenderableUsage}.
 *
 * @param usage - The runtime-neutral usage descriptor.
 */
export function UsageDetail({ usage }: UsageStatusItemProps) {
  if (usage.kind === 'subscription' && usage.utilization != null) {
    const pct = Math.round(usage.utilization * 100);
    const isExhausted = usage.state === 'exhausted';
    const resetsAtLabel = usage.resetsAt
      ? new Date(usage.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">Subscription usage</div>
        <div className="text-3xs space-y-0.5">
          <DetailRow label="Utilization">{`${pct}%`}</DetailRow>
          {usage.windowLabel && <DetailRow label="Window">{usage.windowLabel}</DetailRow>}
          {resetsAtLabel && <DetailRow label="Resets at">{resetsAtLabel}</DetailRow>}
          {usage.costUsd != null && (
            <DetailRow label="Session cost">{`$${usage.costUsd.toFixed(2)}`}</DetailRow>
          )}
          {usage.detail && <div className="text-amber-500">{usage.detail}</div>}
          {isExhausted && <div className="text-red-500">Rate limit reached</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">Session cost</div>
      <div className="text-3xs space-y-0.5">
        {usage.costUsd != null && (
          <DetailRow label="Cost">{`$${usage.costUsd.toFixed(2)}`}</DetailRow>
        )}
        {usage.detail && <div className="text-muted-foreground">{usage.detail}</div>}
      </div>
    </div>
  );
}

/**
 * Merged status-bar item for runtime usage and cost. Subscription sessions
 * render utilization primary (cost in the tooltip); pay-as-you-go sessions, and
 * subscription sessions with no utilization yet, render cost primary. The
 * primary metric flips by `kind` so the two numbers are never both primary.
 *
 * Every branch renders a **number** — a utilization percent or a dollar figure —
 * so the registry marks this item {@link StatusBarItemConfig.rigid} and the row
 * never squeezes it. `shrink-0` here says the same thing one level down: a
 * `$12.4…` or a `7…` is not the same fact in fewer letters, it is a different
 * amount, and the honest failure is for the width budget to drop the whole item
 * to the `⋯` where the figure is still exact.
 *
 * This is the third item that carried `shrink-0` with nothing beside it able to
 * give way (DOR-461 review). The other two were fixed by making them shrinkable,
 * because they had a label to spend; this one has only the number, so it is the
 * row that has to stop asking.
 *
 * @param props - The usage descriptor to render.
 */
export function UsageStatusItem({ usage }: UsageStatusItemProps) {
  const showUtilization = usage.kind === 'subscription' && usage.utilization != null;

  if (showUtilization) {
    const pct = Math.round(usage.utilization! * 100);
    const isExhausted = usage.state === 'exhausted';
    const isWarning = usage.state === 'warning' || pct >= 80;
    const colorClass = isExhausted ? 'text-red-500' : isWarning ? 'text-amber-500' : '';

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex shrink-0 cursor-default items-center gap-1', colorClass)}
            aria-label="Subscription usage"
          >
            <Gauge className="size-(--size-icon-xs)" />
            <span>{pct}%</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56">
          <UsageDetail usage={usage} />
        </TooltipContent>
      </Tooltip>
    );
  }

  // Cost-primary: pay-as-you-go, or a subscription before its first rate-limit
  // signal. Rendered only when a cost is present (parent gate).
  if (usage.costUsd == null) return null;
  // Bounded by magnitude, not by character count: this is the only value in the
  // line that can grow without limit, and a rigid item cannot truncate its way out
  // of one. `formatCost` keeps it to seven characters short of a billion dollars,
  // so the figure never outgrows the slot in the first place. A character limit
  // written for labels was the wrong instrument — it admitted `$99999.99` long
  // after the cluster had run out of room (DOR-461 review). Reachable today only
  // by a pin, which bypasses `promote` entirely.
  const costLabel = formatCost(usage.costUsd);

  if (!usage.detail) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1" aria-label="Session cost">
        <DollarSign className="size-(--size-icon-xs)" />
        <span>{costLabel}</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default items-center gap-1"
          aria-label="Session cost"
        >
          <DollarSign className="size-(--size-icon-xs)" />
          <span>{costLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56">
        <div className="space-y-1">
          <div className="text-xs font-medium">Session cost</div>
          <div className="text-muted-foreground text-3xs">{usage.detail}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
