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
export function hasUsageToShow(usage: AccountUsage | null | undefined): usage is AccountUsage {
  return !!usage && (usage.windows.length > 0 || usage.spend !== null);
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
}

/**
 * An account's 5-hour and weekly bars, or its spend line, or nothing.
 *
 * A window the record lacks is drawn by the bar's unknown branch (a dashed
 * track and the word "unknown"), never as an empty 0% bar.
 */
export function AccountUsageBars({ usage, name }: AccountUsageBarsProps) {
  if (!hasUsageToShow(usage)) return null;
  const hasWindows = usage.windows.length > 0;
  return (
    <div className="space-y-2" data-slot="account-usage-bars">
      {name && <p className="text-sm font-medium">{name}</p>}
      {hasWindows
        ? CARD_WINDOWS.map(({ key, label }) => (
            <UsageBar key={key} window={accountWindow(usage, key)} label={label} />
          ))
        : usage.spend && <SpendLine spend={usage.spend} />}
    </div>
  );
}
