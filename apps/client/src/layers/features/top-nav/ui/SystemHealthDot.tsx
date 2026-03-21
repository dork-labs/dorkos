import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import type { SystemHealthState } from '../model/use-system-health';

/** Tailwind class for each system health state. */
const DOT_STYLES: Record<SystemHealthState, string> = {
  healthy: 'bg-muted-foreground/30',
  degraded: 'bg-amber-500',
  error: 'bg-red-500',
} as const;

/** Human-readable tooltip message for each system health state. */
const TOOLTIP_MESSAGES: Record<SystemHealthState, string> = {
  healthy: 'All systems operational',
  degraded: 'Some adapters disconnected',
  error: 'Issues detected — check Needs Attention',
} as const;

interface SystemHealthDotProps {
  state: SystemHealthState;
}

/** Small colored dot with tooltip indicating overall system health state. */
export function SystemHealthDot({ state }: SystemHealthDotProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('size-2 shrink-0 rounded-full', DOT_STYLES[state])}
          aria-label={TOOLTIP_MESSAGES[state]}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {TOOLTIP_MESSAGES[state]}
      </TooltipContent>
    </Tooltip>
  );
}
