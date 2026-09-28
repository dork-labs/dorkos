import type { ReactNode } from 'react';
import {
  AccountDot,
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  UsageBar,
} from '@/layers/shared/ui';
import { planName, type AccountWindow } from '@/layers/shared/lib';
import type { SessionAccount } from '../model/use-session-account';
import { canOfferContinue, popoverWindowLabel } from '../lib/account-chip';

/** Props for {@link AccountPopover}. */
export interface AccountPopoverProps {
  /** The session's account, from `useSessionAccount`. */
  account: SessionAccount;
  /** The account's name, already resolved by the chip (it renders nothing without one). */
  name: string;
  /** The chip that opens the popover; focus returns to it on close. */
  children: ReactNode;
  /**
   * Opens the "continue on another account" picker. Without it the action is
   * not offered at all, so nothing ships that cannot act.
   */
  onContinue?: () => void;
  /** The moment reset times are read from. */
  now: Date;
  /** Controlled open state, for the Dev Playground. */
  open?: boolean;
  /** Told when the popover opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The windows the popover draws: every readable window in the server's order,
 * or the 5-hour and weekly windows as unknown when there is no reading, so an
 * account with no numbers says "unknown" rather than showing nothing.
 */
function windowsToShow(
  account: SessionAccount
): { key: string; window: AccountWindow | null; label: string }[] {
  const windows = account.usage?.windows ?? [];
  if (windows.length === 0) {
    return [
      { key: 'five_hour', window: null, label: popoverWindowLabel('five_hour', '') },
      { key: 'seven_day', window: null, label: popoverWindowLabel('seven_day', '') },
    ];
  }
  return windows.map((window) => ({
    key: window.key,
    window,
    label: popoverWindowLabel(window.key, window.label),
  }));
}

/**
 * The detail behind the status-bar account chip (spec `claude-account-ui`
 * §6.1): the account and its plan, one bar per usage window with when it
 * resets, the flow item the session serves, and, only while the session is out
 * and the server would take the move, "Continue on another account".
 */
export function AccountPopover({
  account,
  name,
  children,
  onContinue,
  now,
  open,
  onOpenChange,
}: AccountPopoverProps) {
  const plan = planName(account.usage?.plan?.name ?? account.usage?.subscriptionType);
  const offerContinue =
    onContinue !== undefined && canOfferContinue(account.limit, account.lifecycle, account.pending);

  return (
    // `autoFocus` is the sheet's own option, not the DOM attribute: on a phone it
    // moves focus into the sheet, which has no field at its top, so focus does
    // not stay on a chip the modal sheet has hidden from assistive technology.
    // eslint-disable-next-line jsx-a11y/no-autofocus
    <ResponsivePopover open={open} onOpenChange={onOpenChange} autoFocus>
      <ResponsivePopoverTrigger asChild>{children}</ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="top"
        align="start"
        className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
        aria-label={`${name} usage`}
      >
        <ResponsivePopoverTitle>{name}</ResponsivePopoverTitle>
        <div data-slot="account-popover" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {account.color && <AccountDot color={account.color} name={name} />}
              <span className="text-foreground truncate text-sm font-semibold">{name}</span>
            </span>
            {plan && <span className="text-muted-foreground shrink-0 text-xs">{plan}</span>}
          </div>
          <div className="flex flex-col gap-2.5">
            {windowsToShow(account).map(({ key, window, label }) => (
              <UsageBar key={key} window={window} label={label} now={now} />
            ))}
          </div>
          {account.trackerItem && (
            <p className="text-muted-foreground text-2xs">Working on {account.trackerItem.id}</p>
          )}
          {offerContinue && (
            <Button size="sm" onClick={onContinue} className="self-start">
              Continue on another account →
            </Button>
          )}
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
