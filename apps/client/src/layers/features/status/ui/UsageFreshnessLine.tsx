import { formatAsOf } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { MUTED_TEXT, type UsageSurface } from '../lib/usage-surface';

/** Props for {@link UsageFreshnessLine}. */
export interface UsageFreshnessLineProps {
  /** When the numbers above were observed, ISO-8601. */
  observedAt: string;
  /** A fixed moment to read from (tests and the Dev Playground); else the clock. */
  now?: Date;
  /** What the line is painted on; the inverted tooltip needs its own muted text. */
  surface?: UsageSurface;
}

/**
 * The muted line that ends a usage popover or the context tooltip and says how
 * fresh its numbers are: "just now", "as of 12 min ago", "as of 2h ago" (spec
 * `claude-account-ui` §6.8). Re-renders once a minute, so a cached reading ages
 * on screen.
 */
export function UsageFreshnessLine({
  observedAt,
  now: fixedNow,
  surface = 'panel',
}: UsageFreshnessLineProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  return (
    <p data-slot="usage-freshness" className={cn(MUTED_TEXT[surface], 'text-2xs')}>
      {formatAsOf(observedAt, now)}
    </p>
  );
}
