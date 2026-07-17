import { Gauge, DollarSign } from 'lucide-react';
import type { UsageStatus } from '@dorkos/shared/types';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

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

/** One label/value row in the usage detail block. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
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
        <div className="text-xs font-medium">Subscription Usage</div>
        <div className="space-y-0.5 text-[10px]">
          <DetailRow label="Utilization" value={`${pct}%`} />
          {usage.windowLabel && <DetailRow label="Window" value={usage.windowLabel} />}
          {resetsAtLabel && <DetailRow label="Resets at" value={resetsAtLabel} />}
          {usage.costUsd != null && (
            <DetailRow label="Session cost" value={`$${usage.costUsd.toFixed(2)}`} />
          )}
          {usage.detail && <div className="text-amber-500">{usage.detail}</div>}
          {isExhausted && <div className="text-red-500">Rate limit reached</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">Session Cost</div>
      <div className="space-y-0.5 text-[10px]">
        {usage.costUsd != null && <DetailRow label="Cost" value={`$${usage.costUsd.toFixed(2)}`} />}
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
            className={cn('inline-flex cursor-default items-center gap-1', colorClass)}
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
  const costLabel = `$${usage.costUsd.toFixed(2)}`;

  if (!usage.detail) {
    return (
      <span className="inline-flex items-center gap-1" aria-label="Session cost">
        <DollarSign className="size-(--size-icon-xs)" />
        <span>{costLabel}</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1" aria-label="Session cost">
          <DollarSign className="size-(--size-icon-xs)" />
          <span>{costLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56">
        <div className="space-y-1">
          <div className="text-xs font-medium">Session Cost</div>
          <div className="text-muted-foreground text-[10px]">{usage.detail}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
