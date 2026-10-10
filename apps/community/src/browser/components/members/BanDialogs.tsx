import { Button, Label, Textarea } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { FocusDialog } from '../FocusDialog.js';

/** The longest reason a ban keeps, as the server accepts it. */
export const BAN_REASON_MAX = 500;

/**
 * Confirm a ban, with an optional reason only owners and admins see. The reason is trimmed and
 * left out when empty.
 */
export function BanDialog({
  name,
  busy,
  onBan,
  onClose,
}: {
  name: string;
  busy: boolean;
  onBan: (reason: string | undefined) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <FocusDialog title={`Ban ${name}?`} onClose={onClose}>
      <p>They leave the space and can’t rejoin with this account or its email.</p>
      <div className="field">
        <Label htmlFor={`${id}-reason`}>Reason (optional)</Label>
        <Textarea
          id={`${id}-reason`}
          aria-describedby={`${id}-count`}
          maxLength={BAN_REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <span id={`${id}-count`} className="hint">
          {reason.length}/{BAN_REASON_MAX} · Only owners and admins see this.
        </span>
      </div>
      <div className="row justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => onBan(reason.trim() ? reason.trim() : undefined)}
        >
          Ban
        </Button>
      </div>
    </FocusDialog>
  );
}

/** Confirm lifting a ban: the person may join again the usual way. */
export function LiftBanDialog({
  name,
  busy,
  onLift,
  onClose,
}: {
  name: string;
  busy: boolean;
  onLift: () => void;
  onClose: () => void;
}) {
  return (
    <FocusDialog title={`Lift the ban on ${name}?`} onClose={onClose}>
      <p>They can join again. Nothing they had comes back.</p>
      <div className="row justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="default" disabled={busy} onClick={onLift}>
          Lift ban
        </Button>
      </div>
    </FocusDialog>
  );
}
