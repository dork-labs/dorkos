import { Button, Notice } from '@dork-labs/ui';
import { useEffect, useRef, useState } from 'react';
import { COMMUNITY_API_V1_ROUTES } from '@dorkos/shared/community-wire';
import { describeError, hostRequest, RequestError } from '../api.js';
import { HostPolicyLinks } from '../components/HostLinks.js';
import { keepOwnershipSentence } from './copy.js';
import { clearReplacementFragment, readReplacementFragment } from './links.js';

type Preflight = {
  communityName: string;
  claimableAfter: string | null;
  objectionCooldownDays: number;
};
type Stage = 'checking' | 'retry' | 'ready' | 'kept' | 'ended' | 'dead';

/** The one sentence for a link that can't be used, whatever the reason. */
export const DEAD_LINK = 'This link no longer works.';

/**
 * The page the owner's emailed link opens: it can do one thing, keep ownership. Nothing happens
 * on load, so a mail scanner that opens the link changes nothing; the owner presses the button.
 * No sign-in: an owner who has left often can't sign in any more.
 */
export function KeepOwnership() {
  // The inline bootstrap already took the token out of the address bar; it lives only here.
  const [firstToken] = useState(readReplacementFragment);
  const token = useRef(firstToken);
  const [stage, setStage] = useState<Stage>(firstToken ? 'checking' : 'dead');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStage = useRef(stage);

  useEffect(() => () => clearReplacementFragment(), []);

  useEffect(() => {
    if (shownStage.current === stage) return;
    shownStage.current = stage;
    heading.current?.focus();
  }, [stage]);

  function dead() {
    token.current = null;
    clearReplacementFragment();
    setStage('dead');
  }

  async function check() {
    const secret = token.current;
    if (!secret) return dead();
    setError('');
    setStage('checking');
    try {
      const body = await hostRequest<Preflight>(
        COMMUNITY_API_V1_ROUTES.ownerReplacementObjectPreflight,
        'POST',
        { token: secret }
      );
      // The page keeps the token in memory only until the owner presses the button.
      clearReplacementFragment();
      setPreflight(body);
      setStage('ready');
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 403) return dead();
      setError(describeError(cause));
      setStage('retry');
    }
  }

  const started = useRef(false);
  useEffect(() => {
    // Checking the link only reads it; keeping ownership waits for the button. Once per page,
    // even where React runs effects twice.
    if (started.current || !token.current) return;
    started.current = true;
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on the token found at load
  }, []);

  async function keep() {
    const secret = token.current;
    if (!secret) return dead();
    setBusy(true);
    setError('');
    try {
      const body = await hostRequest<{ outcome: 'kept' | 'ended' }>(
        COMMUNITY_API_V1_ROUTES.ownerReplacementObject,
        'POST',
        { token: secret }
      );
      token.current = null;
      setStage(body.outcome === 'kept' ? 'kept' : 'ended');
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 403) dead();
      else setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const title =
    stage === 'ready' && preflight
      ? `Keep ownership of ${preflight.communityName}?`
      : stage === 'kept'
        ? 'You kept ownership. The host has been told.'
        : stage === 'ended'
          ? 'This request has already ended.'
          : stage === 'dead'
            ? DEAD_LINK
            : 'Keep ownership';

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <main className="auth-card" aria-busy={busy || stage === 'checking'}>
        <p className="eyebrow">DorkOS Community</p>
        <h1 ref={heading} tabIndex={-1} className="mb-3">
          {title}
        </h1>
        {error && (
          <Notice role="alert" tone="error" className="mb-4">
            {error}
          </Notice>
        )}
        {stage === 'checking' && <p role="status">Checking your link…</p>}
        {stage === 'retry' && (
          <Button variant="outline" type="button" onClick={() => void check()}>
            Try again
          </Button>
        )}
        {stage === 'ready' && preflight && (
          <>
            <p className="muted mb-6">{keepOwnershipSentence(preflight.objectionCooldownDays)}</p>
            <Button variant="default" type="button" disabled={busy} onClick={() => void keep()}>
              {busy ? 'Keeping ownership…' : 'Keep ownership'}
            </Button>
          </>
        )}
        {stage === 'dead' && (
          <p className="muted">If the host asks again, you’ll get a new email with a new link.</p>
        )}
        <HostPolicyLinks />
      </main>
    </div>
  );
}
