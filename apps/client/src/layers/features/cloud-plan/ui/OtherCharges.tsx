import type { OtherCharges as OtherChargesBlock } from '@dork-labs/cloud-api';
import { formatCharge, type DenominationInput } from '@dork-labs/cloud-api/display';
import { isReadableDenomination } from '../lib/credits';
import { formatPeriod, formatUnits } from '../lib/other-charges';
import { UnreadableFigures } from './UnreadableFigures';

interface OtherChargesProps {
  /** The usage window's charges that are not inference, if the service sent any. */
  otherCharges: OtherChargesBlock | undefined;
  /** The unit the usage response served, which these amounts are in too. */
  denomination: DenominationInput;
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
 *
 * Each figure is a charge in the usage response's own unit, formatted like the
 * inference rows. A response that named no unit keeps the names and dates and
 * shows the "couldn't read" line in place of the figures.
 */
export function OtherCharges({ otherCharges, denomination }: OtherChargesProps) {
  const rows = otherCharges?.rows ?? [];
  if (rows.length === 0) return null;
  const readable = isReadableDenomination(denomination);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Other charges</p>
      {!readable && <UnreadableFigures />}
      <ul className="space-y-2 text-sm">
        {rows.map((row, index) => (
          <li
            // Two rows may share a period, a name and a unit; the index keeps
            // the key unique without inventing an identity the wire lacks.
            key={`${index}-${row.periodStart}-${row.unit}`}
            className="flex items-baseline justify-between gap-4"
          >
            <div className="min-w-0">
              <p className="truncate">{row.displayName}</p>
              <p className="text-muted-foreground text-xs">
                {formatUnits(row.units, row.unit)} ·{' '}
                {/* The dates wrap as one piece, so a narrow screen never
                    splits the range across two lines. */}
                <span className="whitespace-nowrap">
                  {formatPeriod(row.periodStart, row.periodEnd)}
                </span>
              </p>
            </div>
            {readable && (
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {formatCharge(row.dorkosPriceMicro, denomination)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
