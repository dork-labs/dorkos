import { Label } from '@dork-labs/ui';
import { hostRequest } from '../api.js';

/**
 * Tell the host this person confirmed the minimum age, just before an account is created. The
 * server keeps the answer in a short-lived cookie that the password sign-up, the first owner's
 * setup, and a Google, GitHub or single sign-on round trip each carry to account creation.
 */
export async function confirmMinimumAge(): Promise<void> {
  await hostRequest('/api/v1/age-confirmation', 'POST', { confirmed: true });
}

/**
 * The host's minimum age on a sign-up form: one plain line, and a box the person must tick before
 * the form will create an account. The box is `required`, so the browser stops a password sign-up
 * that skipped it; the provider buttons read `confirmed` to stay off until it is ticked.
 */
export function MinimumAgeConfirmation({
  id,
  minimumAge,
  confirmed,
  onChange,
}: {
  id: string;
  minimumAge: number;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
}) {
  return (
    <div className="mb-4">
      <p className="small muted mb-2" id={`${id}-rule`}>
        You must be at least {minimumAge} to join.
      </p>
      <Label htmlFor={id} className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          className="mt-1 size-4 shrink-0"
          aria-describedby={`${id}-rule`}
          checked={confirmed}
          onChange={(event) => onChange(event.target.checked)}
          required
        />
        <span>I am at least {minimumAge} years old.</span>
      </Label>
    </div>
  );
}
