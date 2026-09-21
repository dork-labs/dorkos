import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, request } from '../api.js';
import { FocusDialog } from './CommunityAdministration.js';

type Lifecycle = 'pending_owner' | 'active' | 'archived' | 'suspended' | 'deletion_pending';
type Community = {
  id: string;
  name: string;
  description: string | null;
  lifecycle: Lifecycle;
  lifecycleVersion: number;
  settingsVersion: number;
  ownerPresent: boolean;
  deletionState: 'waiting' | 'deleting' | 'retrying' | null;
  createdAt: string;
};
type Claim = { grantId: string; ownerClaimToken: string; expiresAt: string };
type HostConfirmation = { community: Community; action: 'suspend' | 'abandon' };

function shortId(id: string) {
  return id.slice(-8);
}

/** Manage Community tenants without requesting any tenant content. */
export function HostAdministration() {
  const [communities, setCommunities] = useState<Community[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [admissionPolicy, setAdmissionPolicy] = useState<'invite_only' | 'closed'>('invite_only');
  const [claim, setClaim] = useState<Claim | null>(null);
  const [revokeGrantId, setRevokeGrantId] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<HostConfirmation | null>(null);
  const creationAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const body = await request<{ communities: Community[] }>('/api/v1/host/communities');
      setCommunities(body.communities);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function perform(work: () => Promise<void>, success: string | (() => string)) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
      setMessage(typeof success === 'function' ? success() : success);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    let replayedWithoutClaim = false;
    const fingerprint = JSON.stringify({ name, description: description || null, admissionPolicy });
    if (creationAttempt.current?.fingerprint !== fingerprint) {
      creationAttempt.current = { fingerprint, key: crypto.randomUUID() };
    }
    await perform(
      async () => {
        const body = await request<{
          community: Community;
          ownerClaimGrantId: string;
          ownerClaimToken: string | null;
          expiresAt: string;
        }>('/api/v1/host/communities', 'POST', {
          idempotencyKey: creationAttempt.current!.key,
          name,
          description: description || null,
          admissionPolicy,
        });
        if (body.ownerClaimToken)
          setClaim({
            grantId: body.ownerClaimGrantId,
            ownerClaimToken: body.ownerClaimToken,
            expiresAt: body.expiresAt,
          });
        else replayedWithoutClaim = true;
        setName('');
        setDescription('');
        creationAttempt.current = null;
      },
      () =>
        replayedWithoutClaim
          ? 'The community was already created, but its claim secret cannot be shown again. Use Reissue owner claim on the pending record.'
          : 'Community created. Share the owner claim only with its owner.'
    );
  }

  if (communities === null)
    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <div className="panel p-6">
          {error ? (
            <>
              <p role="alert" className="notice error">
                {error}
              </p>
              <button className="button" onClick={() => void refresh()}>
                Try again
              </button>
            </>
          ) : (
            <div role="status">Opening host administration…</div>
          )}
        </div>
      </main>
    );

  return (
    <main className="settings" aria-labelledby="host-administration-title">
      <p className="eyebrow">Host administration</p>
      <h1 id="host-administration-title">Communities</h1>
      <p className="muted">
        Create and maintain community records. This page does not show community content or member
        details.
      </p>
      {error && (
        <div role="alert" className="notice error mb-4">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="notice success mb-4">
          {message}
        </div>
      )}
      <div className="settings-grid">
        <section className="panel">
          <h2>Create a community</h2>
          <form onSubmit={(event) => void create(event)}>
            <div className="field">
              <label htmlFor="host-community-name">Name</label>
              <input
                id="host-community-name"
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="host-community-description">Description</label>
              <textarea
                id="host-community-description"
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="host-community-admission">Access</label>
              <select
                id="host-community-admission"
                value={admissionPolicy}
                onChange={(event) =>
                  setAdmissionPolicy(event.target.value as 'invite_only' | 'closed')
                }
              >
                <option value="invite_only">Invite only</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <button className="button primary" disabled={busy}>
              Create community
            </button>
          </form>
          {claim && (
            <div className="notice mt-4" role="status">
              <strong>Owner claim</strong>
              <p className="small">
                Share this once. It expires {new Date(claim.expiresAt).toLocaleString()}.
              </p>
              <label htmlFor="owner-claim-token">Claim token</label>
              <input
                id="owner-claim-token"
                readOnly
                value={claim.ownerClaimToken}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="small muted mb-0">Claim ID: {claim.grantId}</p>
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Community records</h2>
          {communities.length === 0 ? (
            <p className="muted">No communities are available.</p>
          ) : (
            <div className="stack">
              {communities.map((community) => {
                const pending = community.lifecycle === 'pending_owner';
                const suspendable =
                  community.lifecycle === 'active' || community.lifecycle === 'archived';
                return (
                  <article
                    className="panel-alt p-4"
                    key={community.id}
                    aria-label={`${community.name} community`}
                  >
                    <div className="row justify-between">
                      <strong>{community.name}</strong>
                      <span className="small muted">{community.lifecycle.replace('_', ' ')}</span>
                    </div>
                    {community.description && (
                      <p className="small muted">{community.description}</p>
                    )}
                    <p className="small muted">
                      ID: {shortId(community.id)} · Owner{' '}
                      {community.ownerPresent ? 'assigned' : 'not assigned'}
                      {community.deletionState ? ` · Cleanup ${community.deletionState}` : ''}
                    </p>
                    <div className="row flex-wrap gap-2">
                      {pending && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const body = await request<Claim>(
                                `/api/v1/host/communities/${community.id}/owner-claims/reissue`,
                                'POST',
                                {}
                              );
                              setClaim(body);
                            }, 'A new owner claim is ready to share.')
                          }
                        >
                          Reissue owner claim
                        </button>
                      )}
                      {suspendable && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => setConfirmation({ community, action: 'suspend' })}
                        >
                          Suspend
                        </button>
                      )}
                      {community.lifecycle === 'suspended' && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              () =>
                                request(
                                  `/api/v1/host/communities/${community.id}/lifecycle`,
                                  'PATCH',
                                  { action: 'resume', lifecycleVersion: community.lifecycleVersion }
                                ),
                              `Resumed ${community.name}.`
                            )
                          }
                        >
                          Resume
                        </button>
                      )}
                    </div>
                    {pending && (
                      <div className="mt-3">
                        <label className="small" htmlFor={`revoke-${community.id}`}>
                          Owner claim ID
                        </label>
                        <div className="row">
                          <input
                            id={`revoke-${community.id}`}
                            value={revokeGrantId[community.id] ?? ''}
                            onChange={(event) =>
                              setRevokeGrantId((old) => ({
                                ...old,
                                [community.id]: event.target.value,
                              }))
                            }
                          />
                          <button
                            className="button"
                            disabled={busy || !revokeGrantId[community.id]}
                            onClick={() =>
                              void perform(
                                () =>
                                  request(
                                    `/api/v1/host/communities/${community.id}/owner-claims/${revokeGrantId[community.id]}/revoke`,
                                    'POST',
                                    {}
                                  ),
                                'Owner claim revoked.'
                              )
                            }
                          >
                            Revoke
                          </button>
                        </div>
                        <button
                          className="button danger mt-2"
                          disabled={busy}
                          onClick={() => setConfirmation({ community, action: 'abandon' })}
                        >
                          Abandon unclaimed community
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {confirmation && (
        <FocusDialog
          title={
            confirmation.action === 'suspend'
              ? `Suspend ${confirmation.community.name}?`
              : `Abandon ${confirmation.community.name}?`
          }
          onClose={() => setConfirmation(null)}
        >
          <p>
            {confirmation.action === 'suspend'
              ? 'Members and agents lose access immediately. Resuming later does not restore revoked credentials.'
              : 'This permanently removes the empty community. It only succeeds after every owner claim is revoked.'}
          </p>
          <div className="row justify-end gap-2">
            <button className="button" onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => {
                const { community, action } = confirmation;
                void perform(
                  () =>
                    action === 'suspend'
                      ? request(`/api/v1/host/communities/${community.id}/lifecycle`, 'PATCH', {
                          action: 'suspend',
                          lifecycleVersion: community.lifecycleVersion,
                        })
                      : request(`/api/v1/host/communities/${community.id}`, 'DELETE'),
                  action === 'suspend'
                    ? `Suspended ${community.name}.`
                    : `Abandoned ${community.name}.`
                ).finally(() => setConfirmation(null));
              }}
            >
              {confirmation.action === 'suspend' ? 'Suspend community' : 'Abandon community'}
            </button>
          </div>
        </FocusDialog>
      )}
    </main>
  );
}
