import { cn } from '@/layers/shared/lib';
import { STATUS_TONE_DOT, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import type { SystemHealthState } from '../model/use-system-health';

/**
 * Tailwind class for each system health state.
 *
 * `healthy` is deliberately NOT the success green: nothing is wrong, so the dot
 * has nothing to say and fades into the bar. The other two speak in the app's
 * shared status vocabulary.
 */
const DOT_STYLES: Record<SystemHealthState, string> = {
  healthy: 'bg-muted-foreground/30',
  degraded: STATUS_TONE_DOT.warning,
  error: STATUS_TONE_DOT.error,
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
