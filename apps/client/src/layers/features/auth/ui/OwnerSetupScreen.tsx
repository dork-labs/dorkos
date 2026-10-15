import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Label, PasswordInput } from '@/layers/shared/ui';
import { describeAuthError, type AuthErrorCopy } from '../lib/auth-error-copy';
import { useSignUp } from '../model/use-auth-session';

/** Better Auth's default minimum password length (scrypt, no verification). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * The two ways a sign-up says "this install already has an owner". Better
 * Auth's duplicate-email check runs before the registration hook, so typing the
 * owner's own email answers `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, and any
 * other email answers `REGISTRATION_CLOSED` (DOR-2964).
 */
const OWNER_EXISTS_CODES = new Set([
  'REGISTRATION_CLOSED',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
]);

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
   * Called when sign-up is rejected because an owner already exists. The
   * argument is the owner's email when the refusal proves it (the typed email
   * is already taken), and `null` when it does not (registration is closed to
   * any other address). The host must then ask the owner to sign in
   * (`OwnerSignInScreen`) and turn login on only after that succeeds: this
   * proves nothing about who is at the keyboard. Either way the form says an
   * owner exists, so a host that cannot find the owner's email leaves the
   * person with a true sentence rather than the auth layer's own words.
   */
  onOwnerExists?: (knownOwnerEmail: string | null) => void | Promise<void>;
  /** Optional cancel affordance. */
  onCancel?: () => void;
}

/** Whether a sign-up error code means an owner account already exists. */
function isOwnerExists(code: string | undefined): boolean {
  return code !== undefined && OWNER_EXISTS_CODES.has(code);
}

/**
 * First-run owner-account creation form (email + password + confirm). Reused by
 * the Settings → Login & security "Require login" flow and the tunnel exposure flow.
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
      setLocalError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setLocalError('Passwords don’t match.');
      return;
    }

    // Better Auth requires a name but accepts an empty one. Left empty so the
    // app asks what to call the owner; the email used to go here and then
    // showed up as their name everywhere (DOR-2964).
    const result = await run(email, password, '');
    if (result.ok) {
      await onCreated();
      return;
    }
    // An owner already exists: hand over to the host's sign-in step. Only a
    // duplicate proves the typed email is the owner's; a single-owner install
    // has no other account it could belong to.
    if (isOwnerExists(result.error.code) && onOwnerExists) {
      await onOwnerExists(result.error.code === 'REGISTRATION_CLOSED' ? null : email);
    }
  }

  const localCopy: AuthErrorCopy | null = localError ? { message: localError, detail: null } : null;
  const errorCopy =
    localCopy ??
    (isOwnerExists(error?.code)
      ? {
          // With a host, the next step is its sign-in; without one, say where to go.
          message: onOwnerExists
            ? 'This computer already has an owner.'
            : 'This computer already has an owner. Sign in instead.',
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
            Only used to sign in here. No email is sent.
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
            <p className="text-destructive text-sm">{errorCopy.message}</p>
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
