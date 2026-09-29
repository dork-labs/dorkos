import { AccountDot } from '@/layers/shared/ui';
import type { SessionRowAccount } from '../model/status/use-session-row-account';

interface AccountMarkProps {
  /** The row's account, from `useSessionRowAccount`. */
  account: SessionRowAccount;
  /**
   * Give the dot a tooltip of its own. Rows pass `false` and name the account
   * in their own tooltip, so two tooltips never open at once.
   */
  tooltip?: boolean;
  className?: string;
}

/**
 * Which account a session spends, as a dot in the account's color that leads
 * the row's title (spec `claude-account-ui` §6.2, decision Q4). The account's
 * name is the dot's accessible name and a tooltip (the dot's own, or the
 * row's when the dot sits in a row), so color is never the only signal; the
 * row no longer prints the name beside it.
 *
 * **Renders only while the account identity gate is open** (two or more
 * accounts on a runtime that tells them apart): with one account every row
 * would wear the same dot. A session whose account cannot be named or colored
 * renders nothing rather than a guess.
 */
export function AccountMark({ account, tooltip = true, className }: AccountMarkProps) {
  if (!account.visible || !account.name || !account.color) return null;
  return (
    <AccountDot color={account.color} name={account.name} tooltip={tooltip} className={className} />
  );
}
