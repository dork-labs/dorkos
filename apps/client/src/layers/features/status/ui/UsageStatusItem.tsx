import { Gauge, DollarSign } from 'lucide-react';
import type { UsageStatus } from '@dorkos/shared/types';
import {
  DetailRow,
  STATUS_TONE_TEXT,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { formatCost } from '../lib/format-tokens';
import { showsStaleMark, staleNumberClass } from '../lib/account-usage-status';
import { MUTED_TEXT, type UsageSurface } from '../lib/usage-surface';
import { UsageFreshnessLine } from './UsageFreshnessLine';

interface UsageDetailProps {
  /** The runtime-neutral usage descriptor. */
  usage: UsageStatus;
  /**
   * What the rows are painted on. `panel` (the default) is a popover or panel
   * on the page's own colors, where the overage note and "Rate limit reached"
   * wear the text-tuned warning and error tokens (4.5:1 or better, both
   * themes). `tooltip` is the inverted tooltip, where no warning or error token
   * reaches 4.5:1 in either theme, so both lines wear the tooltip's own text
   * color and the words carry the state, and the labels and notes wear its
   * own muted step (04 §13).
   */
  surface?: UsageSurface;
}

/** The overage note's and the out-of-usage line's colors, by surface. */
const TONE_BY_SURFACE = {
  panel: { warning: STATUS_TONE_TEXT.warning, error: STATUS_TONE_TEXT.error },
  tooltip: { warning: '', error: '' },
} as const;

interface UsageStatusItemProps extends UsageDetailProps {
  /**
   * When the usage was observed, ISO-8601, or nothing when that is not known
   * (a snapshot's usage). With it, the tooltip ends with the freshness line and
   * a reading older than an hour mutes the number and says "· old" after it (spec
   * `claude-account-ui` §6.8).
   */
  observedAt?: string | null;
  /** A fixed moment to read freshness from (tests and the Dev Playground); else the clock. */
  now?: Date;
}

/**
 * The sentence that has to sit beside a cost figure whose price table is not the
 * published one, or `null` when the figure can be shown plain.
 *
 * A dollar amount reads as a fact, so one computed at rates nobody published has
 * to say so where the number is (the product's honesty rule: no figure claims
 * more precision than it has). `unknown` is the one that is genuinely a guess —
 * no price matched the model at all — and it is worded so a reader knows not to
 * budget against it. `managed` is a real charge at the operator's own
 * organization's rates, so it corrects the reader's assumption rather than
 * warning them.
 *
 * @param usage - The runtime-neutral usage descriptor.
 */
function costBasisNote(usage: UsageStatus): string | null {
  if (usage.costUsd == null) return null;
  switch (usage.costBasis) {
    case 'unknown':
      return 'Estimated — no price was listed for this model.';
    case 'managed':
      return "Charged at your organization's own rates.";
    default:
      return null;
  }
}

/**
 * What to call a cost figure: the same words wherever one is named — the
 * status-bar item's accessible label, its tooltip heading, and the detail body's
 * heading.
 *
 * One rule in one function, because the alternative was the shape this already
 * shipped in once: an accessible name that said "Estimated" over a heading that
 * said the cost was simply the session's, so a screen-reader user and a sighted
 * user were told different things about the same number.
 *
 * @param usage - The runtime-neutral usage descriptor.
 */
function costHeading(usage: UsageStatus): string {
  return usage.costBasis === 'unknown' ? 'Estimated session cost' : 'Session cost';
}

/**
 * The rows under a subscription's utilization: the session's cost (named the
 * way every cost is, "Estimated" when no price matched), the note on how it was
 * priced, the runtime's detail line, and "Rate limit reached" when out. Shared
 * by {@link UsageDetail} and the `/context` reveal's window bars, so the cost
 * reads the same everywhere.
 *
 * @param props - The usage descriptor whose cost to show.
 */
export function UsageCostRows({ usage, surface = 'panel' }: UsageDetailProps) {
  const basisNote = costBasisNote(usage);
  const tone = TONE_BY_SURFACE[surface];
  const muted = MUTED_TEXT[surface];
  return (
    <>
      {usage.costUsd != null && (
        <DetailRow label={costHeading(usage)} labelClassName={muted}>
          {`$${usage.costUsd.toFixed(2)}`}
        </DetailRow>
      )}
      {basisNote && <div className={muted}>{basisNote}</div>}
      {usage.detail && (
        <div data-slot="usage-detail-note" className={tone.warning || undefined}>
          {usage.detail}
        </div>
      )}
      {usage.state === 'exhausted' && (
        <div data-slot="usage-limit-note" className={tone.error || undefined}>
          Rate limit reached
        </div>
      )}
    </>
  );
}

/**
 * The usage & cost detail body — utilization, window, resets, and cost for a
 * subscription; the cost figure for pay-as-you-go. Shared by the status-bar
 * item's hover tooltip and the pinned `/context` reveal so both read identically
 * (DOR-100 / DOR-109). Render only for a usage that {@link hasRenderableUsage}.
 *
 * @param props - The usage descriptor, and the surface the rows are painted on.
 */
export function UsageDetail({ usage, surface = 'panel' }: UsageDetailProps) {
  const basisNote = costBasisNote(usage);
  const muted = MUTED_TEXT[surface];
  if (usage.kind === 'subscription' && usage.utilization != null) {
    const pct = Math.round(usage.utilization * 100);
    const resetsAtLabel = usage.resetsAt
      ? new Date(usage.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium">Subscription usage</div>
        <div className="text-3xs space-y-0.5">
          <DetailRow label="Utilization" labelClassName={muted}>{`${pct}%`}</DetailRow>
          {usage.windowLabel && (
            <DetailRow label="Window" labelClassName={muted}>
              {usage.windowLabel}
            </DetailRow>
          )}
          {resetsAtLabel && (
            <DetailRow label="Resets at" labelClassName={muted}>
              {resetsAtLabel}
            </DetailRow>
          )}
          <UsageCostRows usage={usage} surface={surface} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{costHeading(usage)}</div>
      <div className="text-3xs space-y-0.5">
        {usage.costUsd != null && (
          <DetailRow
            label="Cost"
            labelClassName={muted}
          >{`$${usage.costUsd.toFixed(2)}`}</DetailRow>
        )}
        {basisNote && <div className={muted}>{basisNote}</div>}
        {usage.detail && <div className={muted}>{usage.detail}</div>}
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
export function UsageStatusItem({ usage, observedAt = null, now: fixedNow }: UsageStatusItemProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  const showUtilization = usage.kind === 'subscription' && usage.utilization != null;

  if (showUtilization) {
    const pct = Math.round(usage.utilization! * 100);
    const isExhausted = usage.state === 'exhausted';
    const isWarning = usage.state === 'warning' || pct >= 80;
    // The text-tuned amber and red: each clears 4.5:1 on the status bar in both
    // themes, where text-amber-500 read 2.06:1 and text-red-500 3.60:1 in light.
    const colorClass = isExhausted ? 'text-destructive' : isWarning ? 'text-status-warning-fg' : '';
    // An old reading keeps its number, muted, and says "· old" after it, so the
    // word, not a shade of gray, is what tells it from a fresh one; the tooltip
    // says how old (Q17, 04 §13).
    const stale = showsStaleMark(usage, observedAt, now);
    const numberClass = staleNumberClass(stale);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex shrink-0 cursor-default items-center gap-1', colorClass)}
            aria-label="Subscription usage"
            data-stale={stale || undefined}
          >
            <Gauge className="size-(--size-icon-xs)" />
            <span className={numberClass}>{pct}%</span>
            {stale && <span className={numberClass}>· old</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56">
          <div className="space-y-1">
            <UsageDetail usage={usage} surface="tooltip" />
            {observedAt !== null && (
              <UsageFreshnessLine observedAt={observedAt} now={now} surface="tooltip" />
            )}
          </div>
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
  // A figure priced off something other than the published list has to carry the
  // sentence that says so. The number itself is left exactly as it was: this item
  // is rigid because a truncated amount is a different amount (see above), and a
  // `~` or an `est.` spent on the one value in the row that cannot give width
  // back would buy the qualifier by pushing the whole item into the `⋯`. So the
  // qualifier rides the tooltip and the accessible name, both of which are free.
  const basisNote = costBasisNote(usage);
  const label = costHeading(usage);

  if (!usage.detail && !basisNote) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1" aria-label={label}>
        <DollarSign className="size-(--size-icon-xs)" />
        <span>{costLabel}</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-default items-center gap-1" aria-label={label}>
          <DollarSign className="size-(--size-icon-xs)" />
          <span>{costLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56">
        <div className="space-y-1">
          <div className="text-xs font-medium">{label}</div>
          {basisNote && <div className={cn(MUTED_TEXT.tooltip, 'text-3xs')}>{basisNote}</div>}
          {usage.detail && <div className={cn(MUTED_TEXT.tooltip, 'text-3xs')}>{usage.detail}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
