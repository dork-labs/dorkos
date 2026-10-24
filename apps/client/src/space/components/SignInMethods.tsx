import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { useCallback, useEffect, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { KeyRound, Link2, MailCheck } from 'lucide-react';
import {
  COMMUNITY_PASSWORD_MIN_LENGTH,
  communitySettingsPath,
  type CommunityWireAccountSignInMethods,
} from '@dorkos/shared/community-wire';
import { describeError, hostRequest } from '../api.js';
import { takeSignInError, useSignInOptions } from '../sign-in-options.js';

const authClient = createAuthClient({ baseURL: window.location.origin });

/**
 * How this account signs in, in Settings, Account: its email and whether it was confirmed (with a
 * button to mail a confirmation link where the space sends mail). An account made through the host's single
 * sign-on can add a password here (so an issuer outage cannot lock it out, and the actions that
 * ask for a password work), and a password account can link single sign-on explicitly: the host
 * never links one to an existing account on its own.
 */
export function SignInMethodsPanel({ communityId }: { communityId: string }) {
  const options = useSignInOptions();
  const [methods, setMethods] = useState<CommunityWireAccountSignInMethods | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // A link that failed returns to this page with `?error=`; say why once.
  const [error, setError] = useState(() => takeSignInError() ?? '');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [loaded, session] = await Promise.all([
      hostRequest<CommunityWireAccountSignInMethods>('/api/v1/account/sign-in-methods'),
      hostRequest<{ user?: { email: string } } | null>('/api/auth/get-session'),
    ]);
    setMethods(loaded);
    setEmail(session?.user?.email ?? null);
  }, []);
  useEffect(() => {
    void load().catch((cause: unknown) => setError(describeError(cause)));
  }, [load]);
  const label = options.oidc?.label ?? null;
  if (!methods) return null;

  async function addPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await hostRequest('/api/v1/account/password', 'POST', { newPassword: password });
      setPassword('');
      setMessage('Password added. You can now sign in with your email and this password.');
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendConfirmation() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await hostRequest('/api/v1/account/email-confirmation', 'POST');
      setMessage('Sent. Open the link while signed in here.');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Come back to this panel either way, whatever address the settings were opened from.
      const here = window.location.origin + communitySettingsPath(communityId, 'account');
      const result = await authClient.linkSocial({
        provider: 'oidc',
        callbackURL: here,
        errorCallbackURL: here,
      });
      if (result.error) throw new Error(result.error.message ?? 'Linking could not start.');
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  const via = [methods.password && 'a password', methods.oidc && label].filter(Boolean);
  return (
    <section className="panel" aria-labelledby="sign-in-methods-title">
      <h3 id="sign-in-methods-title">Sign-in</h3>
      {email && (
        <p className="small">
          Email: {email} ·{' '}
          <span className="muted">{methods.emailConfirmed ? 'Confirmed' : 'Not confirmed'}</span>
        </p>
      )}
      {options.emailLinks && !methods.emailConfirmed && (
        <Button
          type="button"
          variant="outline"
          className="mb-3"
          disabled={busy}
          onClick={() => void sendConfirmation()}
        >
          <MailCheck size={16} aria-hidden="true" /> Send confirmation email
        </Button>
      )}
      {(label || !methods.password) && (
        <p className="small muted">
          {via.length
            ? `You sign in with ${via.join(' and ')}.`
            : 'You sign in through another service.'}
        </p>
      )}
      {error && (
        <Notice tone="error" className="mb-3" role="alert">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="info" className="mb-3" role="status">
          {message}
        </Notice>
      )}
      {!methods.password && (
        <form onSubmit={(event) => void addPassword(event)}>
          <p className="small muted">
            Add a password so you can still sign in if single sign-on is down. Exporting, leaving
            and other careful actions ask for it.
          </p>
          <div className="field">
            <Label htmlFor="new-account-password">New password</Label>
            <Input
              id="new-account-password"
              type="password"
              autoComplete="new-password"
              minLength={COMMUNITY_PASSWORD_MIN_LENGTH}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <span className="hint">At least {COMMUNITY_PASSWORD_MIN_LENGTH} characters.</span>
          </div>
          <Button type="submit" variant="outline" disabled={busy}>
            <KeyRound size={16} aria-hidden="true" /> Add password
          </Button>
        </form>
      )}
      {label && !methods.oidc && (
        <Button
          variant="outline"
          className="mt-3"
          type="button"
          disabled={busy}
          onClick={() => void link()}
        >
          <Link2 size={16} aria-hidden="true" /> Link {label}
        </Button>
      )}
    </section>
  );
}
