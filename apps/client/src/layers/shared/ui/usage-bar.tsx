/**
 * How much of an account's usage window is used, drawn as bars: two tiny
 * vertical ones for tight rows ({@link UsageMiniBars}) and one horizontal one
 * for the popover and Settings rows ({@link UsageBar}). Every runtime uses them.
 *
 * A window with no reading is never drawn as an empty 0% bar (spec
 * `claude-account-ui` invariant 3): it gets a dashed outline with no fill and
 * is announced as "unknown". That treatment lives in {@link UnknownTrack}
 * alone, so changing it is a change in one place.
 *
 * @module shared/ui/usage-bar
 */
import {
  barTone,
  formatResetTime,
  type AccountWindow,
  type BarTone,
} from '@/layers/shared/lib/claude-accounts';
import { cn } from '@/layers/shared/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

type KnownTone = Exclude<BarTone, 'unknown'>;

/** The fill of each known tone, through the status tokens. */
const FILL: Record<KnownTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning-dot',
  error: 'bg-status-error',
};

/**
 * How full a bar is drawn, 0 to 100. A window that rejected work with no share
 * reported is out, so it is drawn full.
 */
function fillPct(entry: AccountWindow): number {
  if (entry.usedPct === null) return 100;
  return Math.min(100, Math.max(0, entry.usedPct));
}

/** The share as a person reads it: `40%`. */
function pctText(entry: AccountWindow): string {
  return `${Math.round(fillPct(entry))}%`;
}

/**
 * The track of a window with no reading: a dashed outline and no fill. The one
 * branch every usage bar takes for `unknown`.
 */
function UnknownTrack({ className }: { className: string }) {
  return (
    <span
      data-slot="usage-track"
      data-tone="unknown"
      className={cn('border-border block border border-dashed bg-transparent', className)}
    />
  );
}

/** A solid track with a fill, vertical (bottom-up) or horizontal (left to right). */
function FilledTrack({
  entry,
  tone,
  vertical,
  className,
}: {
  entry: AccountWindow;
  tone: KnownTone;
  vertical: boolean;
  className: string;
}) {
  const pct = `${fillPct(entry)}%`;
  return (
    <span
      data-slot="usage-track"
      data-tone={tone}
      className={cn('bg-muted relative block overflow-hidden', className)}
    >
      <span
        data-slot="usage-fill"
        className={cn(
          'absolute block',
          vertical ? 'inset-x-0 bottom-0' : 'inset-y-0 left-0',
          FILL[tone]
        )}
        // The share is data, not a design value, so it is set inline.
        style={vertical ? { height: pct } : { width: pct }}
      />
    </span>
  );
}

/** One window's track, whichever state it is in. */
function Track({
  entry,
  vertical,
  className,
}: {
  entry: AccountWindow | null;
  vertical: boolean;
  className: string;
}) {
  const tone = barTone(entry);
  if (tone === 'unknown' || !entry) return <UnknownTrack className={className} />;
  return <FilledTrack entry={entry} tone={tone} vertical={vertical} className={className} />;
}

/** `5-hour window 40% used`, or `5-hour window usage unknown`. */
function windowPhrase(name: string, entry: AccountWindow | null): string {
  if (barTone(entry) === 'unknown' || !entry) return `${name} usage unknown`;
  return `${name} ${pctText(entry)} used`;
}

/** Props for {@link UsageMiniBars}. */
export interface UsageMiniBarsProps {
  /** The account's 5-hour window, or `null` with no reading. */
  fiveHour: AccountWindow | null;
  /** The account's weekly window, or `null` with no reading. */
  week: AccountWindow | null;
  /** Extra classes for the pair. */
  className?: string;
}

/**
 * Two tiny vertical bars, the 5-hour window then the week, for a status chip
 * or a list row. Read as one image: "5-hour window 40% used, weekly 72% used".
 */
export function UsageMiniBars({ fiveHour, week, className }: UsageMiniBarsProps) {
  const label = `${windowPhrase('5-hour window', fiveHour)}, ${windowPhrase('weekly', week)}`;
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="usage-mini-bars"
      className={cn('inline-flex shrink-0 items-end gap-0.5', className)}
    >
      <Track entry={fiveHour} vertical className="h-2.5 w-1 rounded-[1px]" />
      <Track entry={week} vertical className="h-2.5 w-1 rounded-[1px]" />
    </span>
  );
}

/** Props for {@link UsageBar}. */
export interface UsageBarProps {
  /** The window to draw, or `null` with no reading. */
  window: AccountWindow | null;
  /** What the window is called on this row, such as `This week`. */
  label: string;
  /** Whether to say when the window resets. */
  showReset?: boolean;
  /** The 110px Settings form: the reset goes in the bar's tooltip instead of beside it. */
  compact?: boolean;
  /** The moment reset times are read from; now when absent. */
  now?: Date;
  /** Extra classes for the row. */
  className?: string;
}

/**
 * One window as a horizontal 6px bar with its label, and "40% · resets
 * 2:10pm" beside it. `compact` is the Settings form: label left, a 110px bar
 * right, and the same text in the bar's tooltip.
 */
export function UsageBar({
  window: entry,
  label,
  showReset = true,
  compact = false,
  now,
  className,
}: UsageBarProps) {
  const tone = barTone(entry);
  const unknown = tone === 'unknown' || !entry;
  const reset =
    showReset && !unknown && entry.resetsAt
      ? formatResetTime(entry.resetsAt, now ?? new Date())
      : null;
  const valueText = unknown ? 'unknown' : `${pctText(entry)}${reset ? ` · resets ${reset}` : ''}`;
  const sentence = `${windowPhrase(label, entry)}${reset ? `, resets ${reset}` : ''}`;

  if (compact) {
    return (
      <div
        data-slot="usage-bar"
        data-tone={tone}
        className={cn('flex items-center justify-between gap-3', className)}
      >
        <span className="text-muted-foreground truncate text-xs">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={sentence}
              className="flex w-[110px] shrink-0 items-center gap-1.5"
            >
              <Track entry={entry} vertical={false} className="h-1.5 w-full rounded-full" />
              {/* Unknown says so in words too, never only as an empty track (Q6). */}
              {unknown && <span className="text-2xs text-muted-foreground shrink-0">unknown</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent>{valueText}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={sentence}
      data-slot="usage-bar"
      data-tone={tone}
      className={cn('flex flex-col gap-1', className)}
    >
      <div className="flex items-baseline justify-between gap-3" aria-hidden>
        <span className="text-foreground truncate text-xs">{label}</span>
        <span className="text-2xs text-muted-foreground shrink-0 tabular-nums">{valueText}</span>
      </div>
      <Track entry={entry} vertical={false} className="h-1.5 w-full rounded-full" />
    </div>
  );
}
