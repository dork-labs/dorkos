import { useEffect, useState } from 'react';
import { Check, Laptop2, ShieldCheck } from 'lucide-react';
import { describeError, request } from '../api.js';

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
/** Review and decide on a verifier-bound local install request. */
export function Pairing() {
  const pairingId = new URLSearchParams(location.search).get('pairingId');
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [error, setError] = useState(pairingId ? '' : 'This approval link is incomplete.');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pairingId) return;
    let active = true;
    void request<PairingStatus>(`/api/v1/pairings/${encodeURIComponent(pairingId)}`)
      .then((body) => {
        if (active) setStatus(body);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error && 'status' in cause && cause.status === 401
              ? 'Sign in to approve this connection.'
              : describeError(cause)
          );
      });
    return () => {
      active = false;
    };
  }, [pairingId]);
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
        {!error && !status && <p role="status">Loading the request…</p>}
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
      </main>
    </div>
  );
}
