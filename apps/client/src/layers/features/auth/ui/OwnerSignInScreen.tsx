import { useId, useState, type FormEvent } from 'react';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import { describeAuthError, type AuthErrorCopy } from '../lib/auth-error-copy';
import { useSignIn } from '../model/use-auth-session';
import type { AuthError } from '../model/auth-client';

/** The command that resets the owner's password, run on the computer DorkOS runs on. */
const RESET_PASSWORD_COMMAND = 'dorkos auth reset-password';

interface OwnerSignInScreenProps {
  /** The existing owner account's email. The person signs in as it; it is not editable. */
  ownerEmail: string;
  /** Submit button label. */
  submitLabel?: string;
  /** Called once the password is proved by a real sign-in. Only then may a host turn login on. */
  onVerified: () => void | Promise<void>;
  /** Optional cancel affordance. */
  onCancel?: () => void;
}

/**
 * Whether a sign-in was refused for the credentials themselves, as opposed to
 * the address, the rate limit or the network. Better Auth answers a wrong
 * password with `INVALID_EMAIL_OR_PASSWORD` and a 401.
 */
function isWrongPassword(error: AuthError): boolean {
  return error.code === 'INVALID_EMAIL_OR_PASSWORD' || error.status === 401;
}

/**
 * The owner signs in before login turns on, for an install that already has an
 * owner account (DOR-2964).
 *
 * Turning on "Require login" with an owner present used to open the create
 * form, which can only fail there. This asks for the owner's password instead
 * and proves it with a real sign-in, through the same rate limit as the login
 * screen, before the host flips `auth.enabled`. A wrong password leaves login
 * off, so nobody can lock themselves out by switching it on.
 */
export function OwnerSignInScreen({
  ownerEmail,
  submitLabel = 'Sign in & require login',
  onVerified,
  onCancel,
}: OwnerSignInScreenProps) {
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [showReset, setShowReset] = useState(false);
  const { run, isPending, error } = useSignIn();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    const result = await run(ownerEmail, password);
    if (result.ok) await onVerified();
  }

  const errorCopy: AuthErrorCopy | null =
    error && isWrongPassword(error)
      ? { message: 'Wrong password. Login is still off.', detail: null }
      : describeAuthError(error, window.location.origin);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm">
        Sign in as <span className="font-medium break-all">{ownerEmail}</span>
      </p>
      {/* Lets a password manager match the saved login to this owner. */}
      <input type="email" autoComplete="username" value={ownerEmail} readOnly hidden aria-hidden />
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>Password</Label>
        <PasswordInput
          id={passwordId}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
        />
        {/* After the field, not beside its label: the dialog focuses its first
            control, and that has to be the password. */}
        <button
          type="button"
          onClick={() => setShowReset((shown) => !shown)}
          aria-expanded={showReset}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Forgot it?
        </button>
        {showReset && (
          <p className="text-muted-foreground text-xs">
            Reset it in a terminal on this computer:{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono">{RESET_PASSWORD_COMMAND}</code>
          </p>
        )}
      </div>

      {errorCopy && (
        <div role="alert" className="space-y-1">
          <p className="text-destructive text-sm">{errorCopy.message}</p>
          {errorCopy.detail && <p className="text-muted-foreground text-xs">{errorCopy.detail}</p>}
        </div>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="flex-1" disabled={isPending}>
          {isPending ? 'Signing in…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
