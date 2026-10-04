import { Button, Field, FieldLabel, Input, Notice } from '@dork-labs/ui';
import { useEffect, useId, useState } from 'react';
import type { CommunityWireSignInLinkNotice } from '@dorkos/shared/community-wire';
import { describeError, hostRequest, RequestError } from '../api.js';

/** What the panel shows: still reading, the form, or a dead end with its reason. */
type State =
  { kind: 'loading' } | { kind: 'form'; provider: string } | { kind: 'ended'; message: string };

const EXPIRED = 'This took too long. Sign in again.';
const NO_PASSWORD = "This account has no password. Ask the space's owner for help.";

/** Reload this page signed in, as a provider sign-in's return would. */
function reloadSignedIn() {
  window.location.assign(window.location.href);
}

/**
 * Finish a provider sign-in whose email matched an account already here: the server held it
 * (`?error=link_needs_password`) until the person enters that account's own password. A right
 * password links the sign-in and signs in, and the page loads again signed in. Shown by every
 * page that offers a provider sign-in, in place of the error.
 */
export function LinkWithPassword({
  onCancel,
  onLinked = reloadSignedIn,
}: {
  /** The person chose not to link; the page shows its sign-in again. */
  onCancel: () => void;
  /** The sign-in is linked and this browser is signed in. */
  onLinked?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordId = useId();

  useEffect(() => {
    let active = true;
    void hostRequest<CommunityWireSignInLinkNotice>('/api/v1/sign-in-link/notice')
      .then((notice) => {
        if (!active) return;
        setState(
          notice.state === 'pending' && notice.provider
            ? { kind: 'form', provider: notice.provider }
            : { kind: 'ended', message: EXPIRED }
        );
      })
      .catch((cause: unknown) => {
        if (active) setState({ kind: 'ended', message: describeError(cause) });
      });
    return () => {
      active = false;
    };
  }, []);

  async function link(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await hostRequest('/api/v1/sign-in-link', 'POST', { password });
      onLinked();
    } catch (cause) {
      const code = cause instanceof RequestError ? cause.code : '';
      // A wrong password may be tried again; anything else ends this sign-in.
      if (code === 'REAUTH_FAILED') setError('That password is not right.');
      else
        setState({
          kind: 'ended',
          message:
            code === 'LINK_EXPIRED'
              ? EXPIRED
              : code === 'PASSWORD_REQUIRED'
                ? NO_PASSWORD
                : describeError(cause),
        });
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    // Cancelling is best effort: the waiting sign-in also ends on its own in 10 minutes.
    await hostRequest('/api/v1/sign-in-link', 'DELETE').catch(() => undefined);
    onCancel();
  }

  if (state.kind === 'loading')
    return (
      <div role="status" className="panel mb-4">
        Checking your sign-in…
      </div>
    );
  return (
    <form className="panel mb-4" onSubmit={(event) => void link(event)}>
      <h2 className="text-lg font-semibold">This email already has an account here.</h2>
      {state.kind === 'ended' ? (
        <Notice tone="error" className="my-3">
          {state.message}
        </Notice>
      ) : (
        <>
          <p className="muted">Enter its password to link {state.provider} sign-in.</p>
          {error && (
            <Notice tone="error" className="mb-3">
              {error}
            </Notice>
          )}
          <Field className="mb-4 gap-1.5">
            <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy || !password}>
            {busy ? 'Linking…' : 'Link and sign in'}
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="link"
        className="mt-2 w-full"
        disabled={busy && state.kind === 'form'}
        onClick={() => void cancel()}
      >
        {state.kind === 'ended' ? 'Back to sign-in' : 'Cancel'}
      </Button>
    </form>
  );
}
