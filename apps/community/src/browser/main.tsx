import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface PairingStatus {
  pairingId: string;
  status: 'pending' | 'approved' | 'expired' | 'cancelled' | 'redeemed';
  installName: string;
  scopes: ('read' | 'post' | 'enroll-agent')[];
  expiresAt: string;
}

function PairingPage() {
  const pairingId = new URLSearchParams(window.location.search).get('pairingId');
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [error, setError] = useState(pairingId ? '' : 'This approval link is incomplete.');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pairingId) return;
    let cancelled = false;
    void fetch(`/api/v1/pairings/${encodeURIComponent(pairingId)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Sign in to approve this connection.'
              : 'This approval request is unavailable.'
          );
        return response.json() as Promise<PairingStatus>;
      })
      .then((body) => {
        if (!cancelled) setStatus(body);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : 'This approval request is unavailable.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [pairingId]);

  async function approve() {
    if (!pairingId) return;
    setBusy(true);
    try {
      const response = await fetch('/api/v1/pairings/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId }),
      });
      if (!response.ok) throw new Error('This approval request is no longer available.');
      setStatus((previous) => (previous ? { ...previous, status: 'approved' } : previous));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be approved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 540,
        margin: 'min(12vh, 6rem) auto',
        padding: '1.5rem',
        fontFamily: 'system-ui',
        lineHeight: 1.5,
      }}
    >
      <p style={{ color: '#686868', marginBottom: 8 }}>DorkOS Community</p>
      <h1 style={{ fontSize: '2rem', marginTop: 0 }}>Connect a local install</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : !status ? (
        <p>Loading the request…</p>
      ) : (
        <>
          <p>
            <strong>{status.installName}</strong> is asking to connect to this community.
          </p>
          <p>
            It would be able to:{' '}
            {status.scopes
              .map(
                (scope) =>
                  ({
                    read: 'read channels',
                    post: 'post messages',
                    'enroll-agent': 'add your agents',
                  })[scope]
              )
              .join(', ')}
            .
          </p>
          {status.status === 'pending' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void approve()}
              style={{ padding: '0.65rem 1rem', cursor: 'pointer' }}
            >
              {busy ? 'Approving…' : 'Approve connection'}
            </button>
          ) : (
            <p role="status">
              {status.status === 'approved'
                ? 'Approved. Return to your local app to finish connecting.'
                : 'This request is no longer available. Start again from your local app.'}
            </p>
          )}
        </>
      )}
    </main>
  );
}

function App() {
  return (
    <main style={{ maxWidth: 640, margin: '5rem auto', padding: '1rem', fontFamily: 'system-ui' }}>
      <h1>DorkOS Community</h1>
      <p>The community service is running. Browser chat is coming in the next release.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname === '/pairing' ? <PairingPage /> : <App />}
  </React.StrictMode>
);
