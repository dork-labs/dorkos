import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { describeError, hostRequest } from '../api.js';
import { forgetCommunity } from '../remembered-community.js';

/**
 * End this browser's host session and nothing else.
 *
 * Memberships and connected installations are separate authority (spec
 * "Vocabulary and action boundaries"), so they keep working. The remembered
 * community is a per-browser convenience, so the next person here starts fresh.
 */
async function signOutOfThisBrowser(): Promise<void> {
  await hostRequest('/api/auth/sign-out', 'POST', {});
  forgetCommunity();
}

/** The one control that signs this browser out, with its own busy and error state. */
export function SignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await signOutOfThisBrowser();
      onSignedOut();
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p className="notice error mb-3" role="alert">
          {error}
        </p>
      )}
      <button className="button" type="button" disabled={busy} onClick={() => void signOut()}>
        <LogOut size={16} /> Sign out of this browser
      </button>
    </>
  );
}

/** What a person sees after signing out: what ended, what did not, and the way back in. */
export function SignedOutPanel() {
  const heading = useRef<HTMLHeadingElement>(null);
  // The control that was focused is gone; start keyboard and screen-reader users here.
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="panel w-full max-w-md p-6" aria-labelledby="signed-out-title">
        <p className="eyebrow">DorkOS Community</p>
        <h1 id="signed-out-title" ref={heading} tabIndex={-1}>
          You signed out of this browser.
        </h1>
        <p className="muted">
          Your memberships did not change. DorkOS installations you connected keep working.
        </p>
        <button
          className="button primary"
          type="button"
          onClick={() => window.location.assign('/')}
        >
          Sign in again
        </button>
      </section>
    </main>
  );
}
