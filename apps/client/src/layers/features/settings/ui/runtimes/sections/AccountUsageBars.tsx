/**
 * One account's usage as Settings → Runtimes draws it (spec `claude-account-ui`
 * §6.5): the 5-hour and weekly bars when the account reports windows, one muted
 * spend line when it reports only spend, and nothing when it reports neither.
 *
 * Shared by the Claude Code card's `ClaudeUsageBlock` and every other runtime's
 * `RuntimeUsageSection`, so both cards follow one rule.
 *
 * @module features/settings/ui/runtimes/sections/AccountUsageBars
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { accountWindow } from '@/layers/shared/lib';
import { UsageBar } from '@/layers/shared/ui';
import { formatCost } from '@/layers/features/status';

/** The two windows every card draws, in order, with the label each bar carries. */
const CARD_WINDOWS = [
  { key: 'five_hour', label: '5-hour window' },
  { key: 'seven_day', label: 'Weekly' },
] as const;

/**
 * Whether an account has anything a card can show: a window, or a spend reading.
 *
 * @param usage - The account's usage, or nothing when there is no record.
 */
export function hasUsageToShow(
  usage: AccountUsage | null | undefined,
  now: Date = new Date()
): usage is AccountUsage {
  return !!usage && (usage.windows.length > 0 || isThisMonthsSpend(usage.spend, now));
}

/**
 * Whether a spend reading belongs to the current local calendar month. A spend
 * reading never goes stale, so a total from an earlier month must not be shown
 * as "this month"; it is hidden until the runtime reports this month's spend.
 *
 * @param spend - The account's spend reading, or nothing.
 * @param now - The moment to read from.
 */
export function isThisMonthsSpend(
  spend: AccountUsage['spend'] | undefined,
  now: Date = new Date()
): spend is NonNullable<AccountUsage['spend']> {
  if (!spend) return false;
  const start = new Date(spend.periodStart);
  if (Number.isNaN(start.getTime())) return false;
  return start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth();
}

/**
 * What an account spent in its billing period, as one small muted line:
 * "$4.20 spent this month". For a runtime billed per turn (OpenCode), which
 * has no windows to draw.
 */
export function SpendLine({ spend }: { spend: NonNullable<AccountUsage['spend']> }) {
  return (
    <p className="text-muted-foreground text-xs tabular-nums" data-slot="spend-line">
      {formatCost(spend.costUsd)} spent this month
    </p>
  );
}

/** Props for {@link AccountUsageBars}. */
export interface AccountUsageBarsProps {
  /** The account's usage record. */
  usage: AccountUsage | null | undefined;
  /** The account's name, printed above the bars; omit to print none. */
  name?: string;
  /** The moment to read from (tests pin it); defaults to now. */
  now?: Date;
}

/**
 * An account's 5-hour and weekly bars, or its spend line, or nothing.
 *
 * A window the record lacks is drawn by the bar's unknown branch (a dashed
 * track and the word "unknown"), never as an empty 0% bar.
 */
export function AccountUsageBars({ usage, name, now = new Date() }: AccountUsageBarsProps) {
  if (!hasUsageToShow(usage, now)) return null;
  const hasWindows = usage.windows.length > 0;
  return (
    <div className="space-y-2" data-slot="account-usage-bars">
      {name && <p className="text-sm font-medium">{name}</p>}
      {hasWindows
        ? CARD_WINDOWS.map(({ key, label }) => (
            <UsageBar key={key} window={accountWindow(usage, key)} label={label} />
          ))
        : isThisMonthsSpend(usage.spend, now) && <SpendLine spend={usage.spend} />}
    </div>
  );
}
