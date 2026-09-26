import type { StorageUsage } from '@dork-labs/cloud-api';
import { formatMicro } from '../lib/micro';
import { formatPeriod, formatUnits } from '../lib/storage-usage';

interface OtherChargesProps {
  /** The usage window's charges that are not inference, if the service sent any. */
  storage: StorageUsage | undefined;
}

/**
 * The usage window's charges that are not inference — storage past what the
 * account includes, and anything like it the service adds later.
 *
 * Each charge is labelled with the service's own `displayName` and `unit`,
 * rendered exactly as given. The credits breakdown above keeps its own total,
 * so these figures are never folded into it. Renders nothing when the service
 * sent no such charges, which is the ordinary case and what an older service
 * always answers.
 */
export function OtherCharges({ storage }: OtherChargesProps) {
  const rows = storage?.rows ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Other charges</p>
      <ul className="space-y-2 text-sm">
        {rows.map((row) => (
          <li
            key={`${row.periodStart}-${row.displayName}`}
            className="flex items-baseline justify-between gap-4"
          >
            <div className="min-w-0">
              <p className="truncate">{row.displayName}</p>
              <p className="text-muted-foreground text-xs">
                {formatUnits(row.units, row.unit)} · {formatPeriod(row.periodStart, row.periodEnd)}
              </p>
            </div>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {formatMicro(row.dorkosPriceMicro)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
