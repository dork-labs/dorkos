import { useCallback, useEffect, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { KeyRound, Link2 } from 'lucide-react';
import {
  COMMUNITY_PASSWORD_MIN_LENGTH,
  communitySettingsPath,
  type CommunityWireAccountSignInMethods,
} from '@dorkos/shared/community-wire';
import { describeError, hostRequest } from '../api.js';
import { takeSignInError, useSignInOptions } from '../sign-in-options.js';

const authClient = createAuthClient({ baseURL: window.location.origin });

/**
 * How this account signs in, in Settings, Account. An account made through the host's single
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
  const load = useCallback(async () => {
    setMethods(
      await hostRequest<CommunityWireAccountSignInMethods>('/api/v1/account/sign-in-methods')
    );
  }, []);
  useEffect(() => {
    void load().catch((cause: unknown) => setError(describeError(cause)));
  }, [load]);
  const label = options.oidc?.label ?? null;
  // Nothing to say: a password account on a host without single sign-on.
  if (!methods || (methods.password && !label)) return null;

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
      <p className="small muted">
        {via.length
          ? `You sign in with ${via.join(' and ')}.`
          : 'You sign in through another service.'}
      </p>
      {error && (
        <p className="notice error mb-3" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice mb-3" role="status">
          {message}
        </p>
      )}
      {!methods.password && (
        <form onSubmit={(event) => void addPassword(event)}>
          <p className="small muted">
            Add a password so you can still sign in if single sign-on is down. Exporting, leaving
            and other careful actions ask for it.
          </p>
          <div className="field">
            <label htmlFor="new-account-password">New password</label>
            <input
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
          <button className="button" disabled={busy}>
            <KeyRound size={16} aria-hidden="true" /> Add password
          </button>
        </form>
      )}
      {label && !methods.oidc && (
        <button className="button mt-3" type="button" disabled={busy} onClick={() => void link()}>
          <Link2 size={16} aria-hidden="true" /> Link {label}
        </button>
      )}
    </section>
  );
}
