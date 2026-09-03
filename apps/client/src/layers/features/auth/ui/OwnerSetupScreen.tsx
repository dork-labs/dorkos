import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Label, PasswordInput } from '@/layers/shared/ui';
import { describeAuthError, type AuthErrorCopy } from '../lib/auth-error-copy';
import { useSignUp } from '../model/use-auth-session';

/** Better Auth's default minimum password length (scrypt, no verification). */
const MIN_PASSWORD_LENGTH = 8;

interface OwnerSetupScreenProps {
  /** Heading for the form; omit (or pass empty) when a wrapping Dialog owns the title. */
  title?: string;
  /** Sub-copy explaining why (e.g. "Exposing DorkOS requires a login."). */
  description?: string;
  /** Submit button label. */
  submitLabel?: string;
  /** Called after the owner account is created. */
  onCreated: () => void | Promise<void>;
  /**
   * Called when sign-up is rejected because an owner already exists
   * (`REGISTRATION_CLOSED`). Lets the enable-login flow proceed to flip the flag
   * without minting a second account. When omitted, the closed-registration
   * message is shown instead.
   */
  onOwnerExists?: () => void | Promise<void>;
  /** Optional cancel affordance. */
  onCancel?: () => void;
}

/**
 * First-run owner-account creation form (email + password + confirm). Reused by
 * the Settings → Security "Require login" flow and the tunnel exposure flow.
 * The email is a local identifier only — never verified, no email is ever sent.
 */
export function OwnerSetupScreen({
  title,
  description,
  submitLabel = 'Create account',
  onCreated,
  onOwnerExists,
  onCancel,
}: OwnerSetupScreenProps) {
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const { run, isPending, error } = useSignUp();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    setLocalError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }

    // name is required by Better Auth email sign-up; the email doubles as the label.
    const result = await run(email, password, email);
    if (result.ok) {
      await onCreated();
      return;
    }
    // An owner already exists: let the enable-login flow proceed to flip the flag.
    if (result.error.code === 'REGISTRATION_CLOSED' && onOwnerExists) {
      await onOwnerExists();
    }
  }

  const registrationClosed = error?.code === 'REGISTRATION_CLOSED' && !onOwnerExists;
  const localCopy: AuthErrorCopy | null = localError ? { message: localError, detail: null } : null;
  const errorCopy =
    localCopy ??
    (registrationClosed
      ? {
          message: 'An owner account already exists for this instance. Sign in instead.',
          detail: null,
        }
      : describeAuthError(error, window.location.origin));

  return (
    <div className="space-y-5">
      {(title || description) && (
        <div className="space-y-1">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <p className="text-muted-foreground text-xs">
            A local identifier only. It is never verified and no email is ever sent.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={passwordId}>Password</Label>
          <PasswordInput
            id={passwordId}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>Confirm password</Label>
          <PasswordInput
            id={confirmId}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {errorCopy && (
          <div role="alert" className="space-y-1">
            <p className="text-sm text-red-500">{errorCopy.message}</p>
            {/* The auth layer's own wording, kept so it can be searched or pasted. */}
            {errorCopy.detail && (
              <p className="text-muted-foreground text-xs">{errorCopy.detail}</p>
            )}
          </div>
        )}

        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
          )}
          <Button type="submit" className="flex-1" disabled={isPending}>
            {isPending ? 'Creating…' : submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
