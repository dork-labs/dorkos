import { useId, useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { Button, Field, FieldLabel, Input, Notice, PasswordInput } from '@/layers/shared/ui';
import { describeAuthError } from '../lib/auth-error-copy';
import { passkeysAvailable } from '../lib/passkey-ceremony';
import { usePasskeySignIn, useSignIn } from '../model/use-auth-session';

interface LoginScreenProps {
  /** Called after a successful sign-in (the guard also reacts to the cleared signal). */
  onSignedIn?: () => void;
}

/** The server's code when a sign-in from another device needs a second step (DOR-3647). */
const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED';

/** The server's code when the second step given did not check out. */
const SECOND_FACTOR_REFUSED = 'SECOND_FACTOR_REFUSED';

/**
 * Sign-in form for a login-protected instance. Rendered full-bleed by the
 * {@link AuthGuard} when a gated request reports that login is required, and to
 * remote visitors reaching an exposed instance. From another device, once the
 * owner has a passkey or an authenticator app, it asks for one as a second step
 * (DOR-3647).
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // What the server said works from here, kept past a wrong code's answer.
  const [methods, setMethods] = useState<readonly string[] | null>(null);
  const { run, isPending, error } = useSignIn();
  const passkey = usePasskeySignIn();
  const needsSecondStep =
    error?.code === SECOND_FACTOR_REQUIRED || error?.code === SECOND_FACTOR_REFUSED;
  // Only what the server says works from this device is offered: a passkey
  // made for the computer DorkOS runs on never is.
  const offerCode = needsSecondStep && (methods === null || methods.includes('authenticator'));
  const offerPasskey = needsSecondStep && passkeysAvailable() && !!methods?.includes('passkey');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    const result = needsSecondStep ? await run(email, password, code) : await run(email, password);
    if (!result.ok && result.error?.methods) setMethods(result.error.methods);
    if (result.ok) onSignedIn?.();
    else setCode('');
  }

  async function handlePasskey() {
    const result = await passkey.run();
    if (result.ok) onSignedIn?.();
  }

  // Rate limits, a refused origin, and anything else the auth layer answers with,
  // all turned into a sentence in one place (see `lib/auth-error-copy`).
  const errorCopy =
    error?.code === SECOND_FACTOR_REQUIRED
      ? null
      : error?.code === SECOND_FACTOR_REFUSED
        ? { message: 'That code didn’t match. Try the newest one.', detail: undefined }
        : describeAuthError(error, window.location.origin);
  const passkeyError = passkey.error?.message;

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="bg-card shadow-elevated w-full max-w-sm rounded-xl border p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-muted mb-3 flex size-11 items-center justify-center rounded-full">
            <Lock className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">
            {needsSecondStep ? 'One more step' : 'Sign in to DorkOS'}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {needsSecondStep
              ? 'Signing in from here needs a second step. Use your passkey or authenticator app.'
              : 'Login is on for this computer.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field className="gap-1.5" hidden={needsSecondStep}>
            <FieldLabel htmlFor={emailId}>Email</FieldLabel>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              aria-describedby={errorCopy ? errorId : undefined}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field className="gap-1.5" hidden={needsSecondStep}>
            <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
            <PasswordInput
              id={passwordId}
              autoComplete="current-password"
              aria-describedby={errorCopy ? errorId : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          {offerCode && (
            <Field className="gap-1.5">
              <FieldLabel htmlFor={codeId}>Enter the code from your authenticator app.</FieldLabel>
              <Input
                id={codeId}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-describedby={errorCopy ? errorId : undefined}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </Field>
          )}

          {errorCopy && (
            <Notice id={errorId} tone="error" className="space-y-1">
              <p>{errorCopy.message}</p>
              {/* The auth layer's own wording, kept so it can be searched or pasted. */}
              {errorCopy.detail && (
                <p className="text-muted-foreground text-xs">{errorCopy.detail}</p>
              )}
            </Notice>
          )}

          <Button
            type="submit"
            className="w-full"
            hidden={needsSecondStep && !offerCode}
            disabled={isPending}
          >
            {isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {offerPasskey && (
          <div className="mt-2 space-y-2">
            {/* One main action: the passkey is quiet beside a code, and main alone. */}
            <Button
              variant={offerCode ? 'link' : 'default'}
              className="w-full"
              onClick={() => void handlePasskey()}
              disabled={passkey.isPending}
            >
              {passkey.isPending
                ? 'Checking…'
                : offerCode
                  ? 'Use a passkey instead'
                  : 'Use a passkey'}
            </Button>
            {passkeyError && (
              <p className="text-destructive text-xs" role="alert">
                {passkeyError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
