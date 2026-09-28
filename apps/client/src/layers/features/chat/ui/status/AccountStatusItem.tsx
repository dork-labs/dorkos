import { useRef, useState } from 'react';
import { AccountItem, type SessionAccount } from '@/layers/features/status';
import { ContinueOnAccountDialog } from '@/layers/features/continue-on-account';

/** Props for {@link AccountStatusItem}. */
export interface AccountStatusItemProps {
  /** The session the chip belongs to. */
  sessionId: string;
  /** The session's account, from `useSessionAccount`. */
  account: SessionAccount;
}

/**
 * The status bar's account chip wired to the "Continue on another account"
 * picker (spec `claude-account-ui` §6.1, §6.6): the popover's action closes
 * the popover and opens the picker, and closing the picker puts focus back on
 * the chip, since the action that opened it is gone with the popover.
 */
export function AccountStatusItem({ sessionId, account }: AccountStatusItemProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);

  return (
    <>
      {/* `contents`, so the wrapper adds no box to the status line's layout. */}
      <span ref={holder} className="contents">
        <AccountItem
          sessionId={sessionId}
          account={account}
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          onContinue={() => {
            setPopoverOpen(false);
            setPickerOpen(true);
          }}
        />
      </span>
      <ContinueOnAccountDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        sessionId={sessionId}
        account={account}
        onCloseAutoFocus={(event) => {
          // The chip is the holder's only button (the popover trigger renames its `data-slot`).
          const chip = holder.current?.querySelector<HTMLElement>('button');
          if (!chip) return;
          event.preventDefault();
          chip.focus();
        }}
      />
    </>
  );
}
