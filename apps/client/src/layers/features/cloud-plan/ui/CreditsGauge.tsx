import { FieldCard, FieldCardContent, Progress } from '@/layers/shared/ui';
import { formatCharge, formatCreditsWithMoney, formatPosition } from '@dork-labs/cloud-api/display';
import { isReadableDenomination, withCreditUnit } from '../lib/credits';
import { remainingFraction } from '../lib/remaining-fraction';
import { useCloudPlan, useCloudUsage } from '../model/use-cloud-plan';
import { useLocalSpend } from '../model/use-local-spend';
import { OtherCharges } from './OtherCharges';
import { UnreadableFigures } from './UnreadableFigures';

/**
 * The credits gauge — what is left, where it went, and what this machine spent
 * on its own.
 *
 * Three honest halves, kept visibly apart:
 *
 * 1. The two numbers somebody has — included this period, and added on top —
 *    with the allowance bar under them, drawn only when there is a denominator
 *    to draw it against, and anything owed on its own line.
 * 2. The per-agent breakdown, straight from the grouped usage rows. Each row's
 *    label is the service's `displayName`; its key is opaque and never rendered.
 *    Charges that are not inference (storage, say) follow as their own list
 *    with their own figures, never added to the credits total.
 * 3. The local spend view, which is the runtimes' own reporting and NOT the
 *    bill. On credits the DorkOS figure is the authoritative one, so the two are
 *    never added together and the local one says what it is.
 *
 * Every Cloud figure is rendered by `@dork-labs/cloud-api/display` in the unit
 * the response served: what is left and what was granted are positions
 * (rounded down), and what each agent spent, and the total, are charges
 * (rounded half away from zero, `<1` for a sliver). The total is the service's
 * exact sum rounded once, never the sum of the rounded rows, so it may differ
 * from them by a credit or two. A response without a unit shows the
 * "couldn't read" line instead of a number.
 */
export function CreditsGauge() {
  // As in PlanCard: the panel owns the loading state, so this only ever runs
  // against a settled read.
  const { data: plan } = useCloudPlan();
  const { data: usage } = useCloudUsage('seat');
  const local = useLocalSpend();

  if (!plan?.available) return null;

  const balance = plan.balance;
  const fraction =
    balance === null
      ? null
      : remainingFraction(balance.allowance.remainingMicro, balance.allowance.grantedMicro);
  const balanceUnit = balance?.denomination;
  const remaining = formatPosition(balance?.allowance.remainingMicro, balanceUnit);
  const granted = withCreditUnit(formatPosition(balance?.allowance.grantedMicro, balanceUnit));
  const added = formatCreditsWithMoney(balance?.purchased.remainingMicro, balanceUnit, 'position');
  // A charge reads exactly "0" only for an exact zero, so any debt at all —
  // even a sliver that reads "<1" — gets its line.
  const owedFigure = formatCharge(balance?.owedMicro, balanceUnit);
  const owed = owedFigure === null || owedFigure === '0' ? null : withCreditUnit(owedFigure);
  const renews = balance ? renewalDate(balance.allowance.resetsAt) : null;
  const rows = usage?.available ? usage.usage.rows : [];
  const usageUnit = usage?.available ? usage.usage.denomination : undefined;
  const usageReadable = isReadableDenomination(usageUnit);
  const total = usage?.available
    ? withCreditUnit(formatCharge(usage.usage.totals.dorkosPriceMicro, usageUnit))
    : null;
  const otherCharges = usage?.available ? usage.usage.otherCharges : undefined;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-4">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">Credits</p>

        {balance !== null &&
          (!isReadableDenomination(balanceUnit) ? (
            <UnreadableFigures />
          ) : (
            <div className="space-y-2">
              {/* The two numbers somebody has: what the plan put in for this
                  period, and what they added on top. Never summed into one,
                  because only one of them renews. */}
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {remaining !== null && granted !== null && (
                  <div>
                    <dt className="text-muted-foreground text-xs">Included</dt>
                    <dd className="font-medium">
                      {remaining} of {granted} left
                    </dd>
                  </div>
                )}
                {added !== null && (
                  <div>
                    <dt className="text-muted-foreground text-xs">Added</dt>
                    <dd className="font-medium">{added}</dd>
                  </div>
                )}
                {/* Debt carried from a turn that overran its reservation. It is
                    never folded quietly into a smaller balance — when it exists
                    it gets its own line. */}
                {owed !== null && (
                  <div>
                    <dt className="text-muted-foreground text-xs">Owed</dt>
                    <dd className="font-medium">{owed}</dd>
                  </div>
                )}
              </dl>
              {fraction !== null && <Progress value={fraction * 100} aria-label="Included left" />}
              {renews !== null && (
                <p className="text-muted-foreground text-xs">Included credits renew {renews}.</p>
              )}
            </div>
          ))}

        {rows.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Where the credits went</p>
            {!usageReadable && <UnreadableFigures />}
            <ul className="space-y-1 text-sm">
              {rows.map((row) => (
                <li key={row.key} className="flex items-baseline justify-between gap-4">
                  <span className="truncate">{row.displayName}</span>
                  {usageReadable && (
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {formatCharge(row.dorkosPriceMicro, usageUnit)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {total !== null && (
              <p className="text-muted-foreground text-xs">Total for the last 30 days: {total}</p>
            )}
          </div>
        )}

        <OtherCharges otherCharges={otherCharges} denomination={usageUnit} />

        {local.hasAnything && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-sm font-medium">On this machine</p>
            {local.sessionCount > 0 && (
              <p className="text-sm">
                {/* The runtimes' own figure. Deliberately labelled as a
                    different thing from the credits above: on credits, the
                    DorkOS cost is the bill and this is not. */}
                {local.totalUsd.toFixed(2)} reported across {local.sessionCount}{' '}
                {local.sessionCount === 1 ? 'open session' : 'open sessions'}, as the runtimes
                priced it.
              </p>
            )}
            {local.runtimesWithoutCost.length > 0 && (
              <p className="text-muted-foreground text-xs">
                {local.runtimesWithoutCost.join(', ')} report no cost, so nothing from them is
                counted here.
              </p>
            )}
          </div>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * When the included credits renew, as a date a person reads ("on 3 Oct").
 *
 * @param resetsAt - The allowance's `resetsAt`, an ISO timestamp.
 * @returns The phrase, or `null` for a timestamp that will not parse.
 */
function renewalDate(resetsAt: string): string | null {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  return `on ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
