import { Button, Input, Label, Notice, Textarea } from '@dork-labs/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, request } from '../api.js';
import { ownerClaimLink } from '../owner-claim.js';
import { FocusDialog } from './CommunityAdministration.js';
import { HostApiKeys } from './HostApiKeys.js';
import { HostCommunityLimits } from './HostCommunityLimits.js';
import { HostHoldControls } from './HostHoldControls.js';
import { HostShortNames } from './HostShortNames.js';
import { HostTakedowns } from '../takedowns/HostTakedowns.js';
import { HostImportForm, HostImportStatus } from './HostImports.js';

type Lifecycle =
  'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
type Community = {
  id: string;
  name: string;
  description: string | null;
  lifecycle: Lifecycle;
  lifecycleVersion: number;
  settingsVersion: number;
  ownerPresent: boolean;
  deletionState: 'waiting' | 'deleting' | 'retrying' | null;
  deletionNoticeAt: string | null;
  deletionRequestedBy: 'owner' | 'host' | null;
  shortName: string | null;
  legalHold: { since: string; reference: string | null } | null;
  importId: string | null;
  importState: string | null;
  takedownId?: string | null;
  createdAt: string;
};
type Claim = { grantId: string; ownerClaimToken: string; expiresAt: string };
type HostConfirmation = { community: Community; action: 'suspend' | 'abandon' };

function shortId(id: string) {
  return id.slice(-8);
}

/**
 * Show a freshly minted owner claim as a link the intended owner opens.
 *
 * The secret stays in the link fragment, so the owner's browser never sends it in a page request.
 */
function OwnerClaimHandoff({ claim }: { claim: Claim }) {
  const link = ownerClaimLink(window.location.origin, claim.ownerClaimToken);
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopy('copied');
    } catch {
      // Clipboard access can be refused; select the link so the person can copy it by hand.
      setCopy('failed');
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <Notice tone="info" className="mt-4">
      <strong>Send this to the new owner</strong>
      <p className="small">
        Send this link only to the person who will own the community. It works once, expires{' '}
        {new Date(claim.expiresAt).toLocaleString()}, and will not be shown again. You can open it
        yourself to become the owner.
      </p>
      <div className="field mb-2">
        <Label htmlFor="owner-claim-link">Owner claim link</Label>
        <div className="row">
          <Input
            id="owner-claim-link"
            ref={input}
            className="min-w-0 flex-1"
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            className="shrink-0"
            type="button"
            onClick={() => void copyLink()}
          >
            {copy === 'copied' ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <p className="small mb-0" aria-live="polite">
        {copy === 'copied'
          ? 'Link copied.'
          : copy === 'failed'
            ? 'This browser blocked copying. Copy the selected link by hand.'
            : ''}
      </p>
      <p className="small muted mb-0">Claim ID: {claim.grantId}</p>
    </Notice>
  );
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
  const [noticeDays, setNoticeDays] = useState(14);
  const creationAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const body = await request<{ communities: Community[]; deletionNoticeDays: number }>(
        '/api/v1/host/communities'
      );
      setCommunities(body.communities);
      setNoticeDays(body.deletionNoticeDays);
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
          ? 'The community was already created, but its owner claim link cannot be shown again. Use Reissue owner claim on the pending record.'
          : 'Community created. Send the owner claim link only to its owner.'
    );
  }

  if (communities === null)
    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <div className="panel p-6">
          {error ? (
            <>
              <Notice role="alert" tone="error">
                {error}
              </Notice>
              <Button variant="outline" onClick={() => void refresh()}>
                Try again
              </Button>
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
      <p className="muted">
        Need a separate host?{' '}
        <a href="https://dorkos.ai/docs/self-hosting/deployment">Deploy a new host</a>. Deployment
        does not create a community on this host.
      </p>
      {error && (
        <Notice role="alert" tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      {message && (
        <Notice role="status" tone="success" className="mb-4">
          {message}
        </Notice>
      )}
      <div className="settings-grid">
        <section className="panel">
          <h2>Create a community</h2>
          <form onSubmit={(event) => void create(event)}>
            <div className="field">
              <Label htmlFor="host-community-name">Name</Label>
              <Input
                id="host-community-name"
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="host-community-description">Description</Label>
              <Textarea
                id="host-community-description"
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="host-community-admission">Access</Label>
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
            <Button type="submit" variant="default" disabled={busy}>
              Create community
            </Button>
          </form>
          {claim && <OwnerClaimHandoff key={claim.grantId} claim={claim} />}
        </section>
        <section className="panel">
          <h2>Community records</h2>
          {communities.length === 0 ? (
            <p className="muted">No communities are available.</p>
          ) : (
            <div className="stack">
              {communities.map((community) => {
                // An unfinished import owns its community until it is ready.
                const importing =
                  community.importState !== null && community.importState !== 'ready';
                const pending = community.lifecycle === 'pending_owner' && !importing;
                const suspendable =
                  community.lifecycle === 'active' ||
                  community.lifecycle === 'archived' ||
                  community.lifecycle === 'held';
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
                      {community.shortName && <>/{community.shortName} · </>}
                      ID: {shortId(community.id)} · Owner{' '}
                      {community.ownerPresent ? 'assigned' : 'not assigned'}
                      {community.deletionState ? ` · Cleanup ${community.deletionState}` : ''}
                    </p>
                    {community.legalHold && (
                      <div className="small">
                        <p>
                          Legal hold since{' '}
                          {new Date(community.legalHold.since).toLocaleDateString()}
                          {community.legalHold.reference
                            ? ` (${community.legalHold.reference})`
                            : ''}
                          .{' '}
                          {community.lifecycle === 'deletion_pending'
                            ? 'Its deletion is paused until the hold is released.'
                            : 'This community can’t be deleted until the hold is released.'}
                        </p>
                        <p className="muted">
                          The hold doesn’t stop single messages or files being removed, or a person
                          erasing their own data. See “Legal holds” in OPERATIONS.md.
                        </p>
                      </div>
                    )}
                    <div className="row flex-wrap gap-2">
                      {pending && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const body = await request<Claim>(
                                `/api/v1/host/communities/${community.id}/owner-claims/reissue`,
                                'POST',
                                {}
                              );
                              setClaim(body);
                            }, 'A new owner claim link is ready to send.')
                          }
                        >
                          Reissue owner claim
                        </Button>
                      )}
                      {suspendable && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirmation({ community, action: 'suspend' })}
                        >
                          Suspend
                        </Button>
                      )}
                      {community.lifecycle === 'suspended' && (
                        <Button
                          variant="outline"
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
                        </Button>
                      )}
                    </div>
                    {community.importId && community.lifecycle === 'pending_owner' && (
                      <HostImportStatus
                        importId={community.importId}
                        onChanged={() => void refresh()}
                      />
                    )}
                    <div className="mt-3">
                      <HostHoldControls
                        community={community}
                        busy={busy}
                        noticeDays={noticeDays}
                        perform={perform}
                      />
                    </div>
                    {community.lifecycle !== 'deletion_pending' && (
                      <HostShortNames
                        communityId={community.id}
                        name={community.name}
                        onChanged={refresh}
                      />
                    )}
                    {community.lifecycle !== 'deletion_pending' && (
                      <HostCommunityLimits communityId={community.id} name={community.name} />
                    )}
                    {community.lifecycle !== 'pending_owner' && (
                      <HostTakedowns community={community} />
                    )}
                    {pending && (
                      <div className="field mt-3 mb-0">
                        <Label htmlFor={`revoke-${community.id}`}>Owner claim ID</Label>
                        <div className="row">
                          <Input
                            id={`revoke-${community.id}`}
                            className="min-w-0 flex-1"
                            value={revokeGrantId[community.id] ?? ''}
                            onChange={(event) =>
                              setRevokeGrantId((old) => ({
                                ...old,
                                [community.id]: event.target.value,
                              }))
                            }
                          />
                          <Button
                            variant="outline"
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
                          </Button>
                        </div>
                        <Button
                          variant="destructive"
                          className="mt-2"
                          disabled={busy}
                          onClick={() => setConfirmation({ community, action: 'abandon' })}
                        >
                          Abandon unclaimed community
                        </Button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      <HostImportForm onStarted={() => void refresh()} />
      <HostApiKeys />
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
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
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
            </Button>
          </div>
        </FocusDialog>
      )}
    </main>
  );
}
