import { FieldCard, FieldCardContent, Progress } from '@/layers/shared/ui';
import { formatMicro, remainingFraction } from '../lib/micro';
import { useCloudPlan, useCloudUsage } from '../model/use-cloud-plan';
import { useLocalSpend } from '../model/use-local-spend';

/**
 * The credits gauge — what is left, where it went, and what this machine spent
 * on its own.
 *
 * Three honest halves, kept visibly apart:
 *
 * 1. The allowance bar, drawn only when there is a denominator to draw it
 *    against.
 * 2. The per-agent breakdown, straight from the grouped usage rows. Each row's
 *    label is the service's `displayName`; its key is opaque and never rendered.
 * 3. The local spend view, which is the runtimes' own reporting and NOT the
 *    bill. On credits the DorkOS figure is the authoritative one, so the two are
 *    never added together and the local one says what it is.
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
  const rows = usage?.available ? usage.usage.rows : [];
  const total = usage?.available ? formatMicro(usage.usage.totals.dorkosPriceMicro) : null;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-4">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">Credits</p>

        {balance !== null && fraction !== null && (
          <div className="space-y-1">
            <Progress value={fraction * 100} />
            <p className="text-muted-foreground text-xs">
              {formatMicro(balance.allowance.remainingMicro)} of{' '}
              {formatMicro(balance.allowance.grantedMicro)} left in this period
            </p>
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Where the credits went</p>
            <ul className="space-y-1 text-sm">
              {rows.map((row) => (
                <li key={row.key} className="flex items-baseline justify-between gap-4">
                  <span className="truncate">{row.displayName}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {formatMicro(row.dorkosPriceMicro)}
                  </span>
                </li>
              ))}
            </ul>
            {total !== null && (
              <p className="text-muted-foreground text-xs">Total for the last 30 days: {total}</p>
            )}
          </div>
        )}

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
