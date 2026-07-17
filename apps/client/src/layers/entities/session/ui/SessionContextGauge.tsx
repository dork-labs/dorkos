import { CircleDashed, Recycle } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
// Same-slice imports via sibling modules (not the entities/session barrel).
import { useSessionContextHealth } from '../model/use-session-context-health';
import type { ContextSeverity } from '../lib/context-health';

/** Severity → text color, matching `ContextItem`'s amber/red vocabulary. */
const SEVERITY_TEXT: Record<ContextSeverity, string> = {
  ok: 'text-muted-foreground/60',
  warning: 'text-amber-500',
  critical: 'text-red-500',
};

/**
 * A quiet severity ring — a filled arc proportional to `percent`, drawn in
 * `currentColor` so the parent's severity tint carries through. Decorative
 * (`aria-hidden`); the accessible name lives on the gauge root.
 */
function ContextRing({ percent }: { percent: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg viewBox="0 0 18 18" className="size-3.5 shrink-0" aria-hidden="true">
      <circle
        cx="9"
        cy="9"
        r={radius}
        className="fill-none stroke-current opacity-20"
        strokeWidth="2.5"
      />
      <circle
        cx="9"
        cy="9"
        r={radius}
        className="fill-none stroke-current"
        strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

/** The discreet "auto-compacted" marker — presence in the tail is the signal. */
function AutoCompactedMarker({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground/50 inline-flex cursor-default items-center">
          <Recycle className="size-3 shrink-0" aria-label="Auto-compacted" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        Auto-compacted {formatRelativeTime(at)} to free up context.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A small, glanceable per-row context gauge (spec §8a). Reads
 * {@link useSessionContextHealth} and renders one of three honest states,
 * quiet-not-alarm:
 *
 * - **Known** — a severity-tinted ring + compact percent (`ok` muted, `warning`
 *   amber, `critical` red). A list (not-live) reading adds an "as of …" line.
 * - **Unknown** — a muted dashed glyph, no number, no color; never a fake 0%.
 * - **Auto-compacted** — a discreet recycle marker rides EITHER state when the
 *   session's tail carries a recent auto-compaction.
 *
 * Presentational within the `role="button"` row: the triggers are non-interactive
 * spans that let clicks bubble, so the gauge never steals the row's click target.
 *
 * @param session - The session row to gauge.
 */
export function SessionContextGauge({ session }: { session: Session }) {
  const health = useSessionContextHealth(session);

  return (
    <span className="inline-flex items-center gap-1" data-testid="session-context-gauge">
      {health.autoCompactedAt && <AutoCompactedMarker at={health.autoCompactedAt} />}
      {health.status === 'known' && health.percent != null && health.severity ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex cursor-default items-center gap-1',
                SEVERITY_TEXT[health.severity]
              )}
              aria-label={`Context ${health.percent}% full`}
            >
              <ContextRing percent={health.percent} />
              <span className="text-[10px] tabular-nums">{health.percent}%</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div>Context {health.percent}% full</div>
            {!health.fresh && (
              <div className="text-muted-foreground">as of {formatRelativeTime(health.asOf)}.</div>
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="text-muted-foreground/40 inline-flex cursor-default items-center"
              aria-label="Context usage unknown"
            >
              <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            Context usage isn&apos;t available for this session yet. Open it to see live usage.
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
