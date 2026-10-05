import { Button, Field, FieldLabel, Input, Notice } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { COMMUNITY_PASSWORD_MIN_LENGTH } from '@dorkos/shared/community-wire';
import { hostRequest, RequestError } from '../api.js';
import {
  CommonStates,
  continueToApp,
  EmailLinkPage,
  failure,
  useEmailLink,
} from './EmailLinkPage.js';

type Blocked = 'signed-out' | 'other-account' | null;

/** Why this browser cannot confirm, from who it is signed in as. */
function blockedBy(signedInAs: { email: string } | null, email: string): Blocked {
  if (!signedInAs) return 'signed-out';
  return signedInAs.email.toLowerCase() === email.toLowerCase() ? null : 'other-account';
}

/**
 * The page a mailed confirmation link opens. It confirms only for a browser signed in as the
 * link's own account: the mailbox alone is not enough, so nobody can be tricked into confirming
 * an account someone else made with their address. Confirming an address that was never
 * confirmed also signs out other devices, and the page says so first.
 */
export function ConfirmEmail() {
  const link = useEmailLink();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'none' | 'others' | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const passwordId = useId();
  const { state } = link;
  const peek = state.kind === 'ready' ? state.peek : null;
  const shownBlock = blocked ?? (peek ? blockedBy(peek.signedInAs, peek.email) : null);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    const token = link.token.current;
    if (!token) return link.expire();
    setBusy(true);
    try {
      const body = await hostRequest<{ cleared: 'none' | 'others' }>(
        '/api/v1/account/email-confirmation/confirm',
        'POST',
        peek?.needsPassword ? { token, newPassword: password } : { token }
      );
      link.token.current = null;
      setDone(body.cleared);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 401) setBlocked('signed-out');
      else if (cause instanceof RequestError && cause.code === 'FORBIDDEN')
        setBlocked('other-account');
      else link.setState(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = done
    ? 'Email confirmed.'
    : state.kind === 'expired'
      ? 'This link expired or was already used.'
      : peek
        ? `Confirm ${peek.email} for this account?`
        : 'Confirm your email';

  return (
    <EmailLinkPage title={title} busy={busy || state.kind === 'checking'}>
      {done ? (
        <>
          {done === 'others' && <p className="muted mb-6">Other devices were signed out.</p>}
          <Button type="button" onClick={continueToApp}>
            Continue
          </Button>
        </>
      ) : state.kind === 'expired' ? (
        <p className="muted">Send a new one from Settings.</p>
      ) : peek && shownBlock === 'signed-out' ? (
        <>
          <p className="muted mb-4">Sign in, then open this link again.</p>
          <Button type="button" onClick={continueToApp}>
            Sign in
          </Button>
        </>
      ) : peek && shownBlock === 'other-account' ? (
        <Notice role="alert" tone="error">
          This link is for another account. Sign in as that account.
        </Notice>
      ) : peek ? (
        <form onSubmit={(event) => void confirm(event)}>
          {peek.clears.length > 0 && (
            <>
              <p className="muted mb-2">
                Confirming signs out your other devices and ends DorkOS connections.
              </p>
              <p className="muted mb-4">
                It also ends agent keys, pairings, invitation links and server API keys.
              </p>
            </>
          )}
          {peek.needsPassword && (
            <Field className="mb-4 gap-1.5">
              <FieldLabel htmlFor={passwordId}>New password</FieldLabel>
              <Input
                id={passwordId}
                type="password"
                autoComplete="new-password"
                minLength={COMMUNITY_PASSWORD_MIN_LENGTH}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <span className="hint">At least {COMMUNITY_PASSWORD_MIN_LENGTH} characters.</span>
            </Field>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy
              ? 'Confirming…'
              : peek.needsPassword
                ? 'Confirm and choose a new password'
                : 'Confirm email'}
          </Button>
        </form>
      ) : (
        <CommonStates state={state} onRetry={() => void link.check()} />
      )}
    </EmailLinkPage>
  );
}
