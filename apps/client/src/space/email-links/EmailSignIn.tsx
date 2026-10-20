import { Button } from '@dork-labs/ui';
import { useState } from 'react';
import { hostRequest } from '../api.js';
import {
  CommonStates,
  continueToApp,
  EmailLinkPage,
  failure,
  OtherAccountNotice,
  useEmailLink,
} from './EmailLinkPage.js';

type Done = { cleared: boolean; linked: string | null };

/**
 * The page a mailed sign-in link opens. It names the account before anything happens, so a
 * sign-in link someone else sent (to sign this browser in as them) is seen for what it is; the
 * person signs in only by pressing the button. It works only in the browser that asked.
 */
export function EmailSignIn() {
  const link = useEmailLink();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const { state } = link;

  async function signIn() {
    const token = link.token.current;
    if (!token) return link.expire();
    setBusy(true);
    try {
      const body = await hostRequest<Done>('/api/auth/email-link/sign-in', 'POST', { token });
      link.token.current = null;
      setDone(body);
    } catch (cause) {
      link.setState(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = done
    ? 'Signed in'
    : state.kind === 'expired'
      ? 'This link expired, was used, or was opened elsewhere.'
      : state.kind === 'ready'
        ? `Sign in as ${state.peek.email}?`
        : 'Sign in';

  return (
    <EmailLinkPage title={title} busy={busy || state.kind === 'checking'}>
      {done ? (
        <>
          {(done.cleared || done.linked) && (
            <p className="muted mb-6">
              {done.cleared
                ? 'The old password and other sign-ins were removed.'
                : `${done.linked} sign-in is now linked.`}
            </p>
          )}
          <Button type="button" onClick={continueToApp}>
            Continue
          </Button>
        </>
      ) : state.kind === 'expired' ? (
        <p className="muted">Open it in the browser where you asked.</p>
      ) : state.kind === 'ready' ? (
        <>
          <OtherAccountNotice
            peek={state.peek}
            text={(other) =>
              `You're signed in as ${other}. Continuing switches to ${state.peek.email}.`
            }
          />
          {state.peek.clears.length > 0 && (
            <p className="muted mb-4">
              Signing in removes this account’s old password and other sign-ins.
            </p>
          )}
          <Button type="button" className="w-full" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button
            type="button"
            variant="link"
            className="mt-2 w-full"
            onClick={() => window.close()}
          >
            Not you? Close this page.
          </Button>
        </>
      ) : (
        <CommonStates state={state} onRetry={() => void link.check()} />
      )}
    </EmailLinkPage>
  );
}
