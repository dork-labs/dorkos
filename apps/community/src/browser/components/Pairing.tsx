import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Laptop2, ShieldCheck } from 'lucide-react';
import type { CommunityWireMembershipSummary } from '@dorkos/shared/community-wire';
import { describeError, hostRequest, RequestError, request } from '../api.js';
import { HostPolicyLinks } from './HostLinks.js';

type PairingStatus = {
  pairingId: string;
  status: 'pending' | 'approved' | 'expired' | 'cancelled' | 'redeemed';
  installName: string;
  scopes: ('read' | 'post' | 'enroll-agent')[];
  expiresAt: string;
};
const scopeLabel = {
  read: 'Read channels',
  post: 'Post messages',
  'enroll-agent': 'Add your agents',
};
/**
 * Whether the host holds the community in this page's path. A pairing approved during a hold
 * stays read-only after release, so the page says so before anyone approves it. Any failure
 * reads as not held: the note is advice, and the server decides what the grant can do.
 */
async function isHeldCommunity(path = window.location.pathname): Promise<boolean> {
  const communityId = path.match(/^\/c\/([^/]+)\//u)?.[1];
  if (!communityId) return false;
  try {
    const body = await hostRequest<{ memberships: CommunityWireMembershipSummary[] }>(
      '/api/v1/memberships'
    );
    return body.memberships.some(
      (membership) => membership.communityId === communityId && membership.lifecycle === 'held'
    );
  } catch {
    return false;
  }
}

/** Review and decide on a verifier-bound local install request. */
export function Pairing({ search = location.search }: { search?: string }) {
  const pairingId = new URLSearchParams(search).get('pairingId');
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [error, setError] = useState(pairingId ? '' : 'This approval link is incomplete.');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);

  const loadPairing = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      if (!pairingId) return;
      try {
        const body = await request<PairingStatus>(
          `/api/v1/pairings/${encodeURIComponent(pairingId)}`
        );
        if (!isCurrent()) return;
        setStatus(body);
        setNeedsSignIn(false);
        setError('');
        const onHold = await isHeldCommunity();
        if (isCurrent()) setHeld(onHold);
      } catch (cause) {
        if (!isCurrent()) return;
        setStatus(null);
        if (cause instanceof RequestError && cause.status === 401) {
          setNeedsSignIn(true);
          setError('');
        } else {
          setNeedsSignIn(false);
          setError(describeError(cause));
        }
      }
    },
    [pairingId]
  );

  useEffect(() => {
    if (!pairingId) return;
    let active = true;
    void Promise.resolve().then(() => loadPairing(() => active));
    return () => {
      active = false;
    };
  }, [loadPairing, pairingId]);

  useEffect(() => {
    if (needsSignIn) emailInput.current?.focus();
  }, [needsSignIn]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request('/api/auth/sign-in/email', 'POST', { email, password });
      await loadPairing();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decide(action: 'approve' | 'decline') {
    if (!pairingId) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/pairings/${action}`, 'POST', { pairingId });
      setStatus((previous) =>
        previous
          ? { ...previous, status: action === 'approve' ? 'approved' : 'cancelled' }
          : previous
      );
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div>
          <p className="eyebrow">DorkOS Community</p>
          <h2 className="mt-10 text-4xl font-semibold tracking-tight">Your space, your say.</h2>
          <p className="mt-4 max-w-md text-lg text-[#d0e4d3]">
            Approve a local install only when you recognize it and the access it needs.
          </p>
        </div>
        <p className="text-sm text-[#aec4b1]">You can remove access later in Account settings.</p>
      </div>
      <main className="auth-card">
        <p className="eyebrow">Connection request</p>
        <h1>Connect a local install</h1>
        <p className="muted mb-7">Review what this install can do before approving.</p>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {needsSignIn && (
          <form className="panel" onSubmit={(event) => void signIn(event)}>
            <div className="notice mb-5">
              Sign in to review this connection. The request will stay on this page.
            </div>
            <div className="field">
              <label htmlFor="pairing-email">Email</label>
              <input
                id="pairing-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                ref={emailInput}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="pairing-password">Password</label>
              <input
                id="pairing-password"
                type="password"
                autoComplete="current-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <span className="hint">
                Forgot your password? Ask the person running this community for help.
              </span>
            </div>
            <button className="button primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in and review'}
              <KeyRound size={16} />
            </button>
          </form>
        )}
        {!error && !status && !needsSignIn && <p role="status">Loading the request…</p>}
        {status && (
          <div className="panel p-6">
            <div className="row mb-5">
              <span className="avatar">
                <Laptop2 size={20} />
              </span>
              <div>
                <strong className="block break-all">{status.installName}</strong>
                <span className="small muted">Wants to connect to this community</span>
              </div>
            </div>
            <p className="small mb-2 font-semibold">It would be able to:</p>
            <ul className="stack mb-6">
              {status.scopes.map((scope) => (
                <li className="row" key={scope}>
                  <ShieldCheck size={16} className="text-[var(--accent)]" />
                  {scopeLabel[scope]}
                </li>
              ))}
            </ul>
            {held && status.status === 'pending' && (
              <p className="notice mb-5">
                The community is on hold, so this connection can only read. Connect again after the
                hold ends to post.
              </p>
            )}
            {status.status === 'pending' ? (
              <div className="row">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void decide('approve')}
                >
                  {busy ? 'Working…' : 'Approve connection'}
                  <Check size={17} />
                </button>
                <button className="button" disabled={busy} onClick={() => void decide('decline')}>
                  Decline
                </button>
              </div>
            ) : status.status === 'approved' ? (
              <div role="status" className="notice success">
                Approved. Return to your local app to finish connecting.
              </div>
            ) : (
              <div role="status" className="notice">
                {status.status === 'cancelled'
                  ? 'Connection declined. You can close this page.'
                  : 'This request is no longer available. Start again from your local app.'}
              </div>
            )}
          </div>
        )}
        <HostPolicyLinks />
      </main>
    </div>
  );
}
