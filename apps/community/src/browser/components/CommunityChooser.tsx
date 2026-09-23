import { useEffect, useState, type ReactNode } from 'react';
import type { CommunityWireMembershipSummary } from '@dorkos/shared/community-wire';
import { describeError, RequestError, request } from '../api.js';

const LAST_COMMUNITY_KEY = 'communityLastAuthorizedId';

/** Remember an authorized canonical selection without treating it as authority. */
export function rememberCommunity(communityId: string): void {
  localStorage.setItem(LAST_COMMUNITY_KEY, communityId);
}

function enterCommunity(communityId: string, replace = false, deletion = false): void {
  rememberCommunity(communityId);
  const path = `/c/${communityId}${deletion ? '/deletion' : ''}`;
  if (replace) window.location.replace(path);
  else window.location.assign(path);
}

/** Select one of the signed-in account's own memberships at the host root. */
export function CommunityChooser({ signedOut }: { signedOut: () => ReactNode }) {
  const [memberships, setMemberships] = useState<CommunityWireMembershipSummary[] | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [error, setError] = useState('');
  const pendingInvite = sessionStorage.getItem('communityPendingInvite');

  useEffect(() => {
    let current = true;
    if (pendingInvite) {
      const path = sessionStorage.getItem('communityPendingInvitePath');
      if (
        path &&
        /^\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(path)
      ) {
        window.location.replace(path);
      } else setUnauthenticated(true);
      return;
    }
    void request<{ memberships: CommunityWireMembershipSummary[] }>('/api/v1/memberships')
      .then(({ memberships: next }) => {
        if (!current) return;
        const remembered = next.find(
          (membership) =>
            membership.communityId === localStorage.getItem(LAST_COMMUNITY_KEY) &&
            membership.lifecycle === 'deletion_pending' &&
            membership.role === 'owner'
        );
        if (remembered) {
          enterCommunity(remembered.communityId, true, true);
          return;
        }
        if (next.length === 1 && next[0].lifecycle === 'active') {
          enterCommunity(next[0].communityId, true);
          return;
        }
        setMemberships(next);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof RequestError && cause.status === 401) setUnauthenticated(true);
        else setError(describeError(cause));
      });
    return () => {
      current = false;
    };
  }, [pendingInvite]);

  if (unauthenticated) return signedOut();
  if (!memberships && !error)
    return (
      <main className="grid min-h-dvh place-items-center">
        <div role="status" className="panel p-6">
          <p className="eyebrow">DorkOS Community</p>
          <p className="mb-0">Opening your communities…</p>
        </div>
      </main>
    );
  return (
    <main className="grid min-h-dvh place-items-center p-5">
      <section className="panel w-full max-w-xl p-6" aria-labelledby="community-chooser-title">
        <p className="eyebrow">DorkOS Community</p>
        <h1 id="community-chooser-title">Choose a community</h1>
        {error ? (
          <p role="alert" className="notice error">
            {error}
          </p>
        ) : memberships?.length === 0 ? (
          <p className="muted">This account does not have a community membership yet.</p>
        ) : (
          <div className="stack">
            {memberships?.map((membership) => {
              const deletionRecovery =
                membership.lifecycle === 'deletion_pending' && membership.role === 'owner';
              const available =
                membership.lifecycle === 'active' ||
                membership.lifecycle === 'archived' ||
                deletionRecovery;
              const remembered =
                localStorage.getItem(LAST_COMMUNITY_KEY) === membership.communityId;
              return (
                <button
                  key={membership.communityId}
                  className="button justify-between text-left"
                  disabled={!available}
                  onClick={() => enterCommunity(membership.communityId, false, deletionRecovery)}
                >
                  <span>
                    <strong>{membership.name}</strong>
                    <span className="small muted block">
                      {membership.role} · signed in as {membership.displayName}
                    </span>
                  </span>
                  <span className="small muted">
                    {deletionRecovery
                      ? 'Review deletion'
                      : available
                        ? membership.lifecycle === 'archived'
                          ? 'Read history'
                          : remembered
                            ? 'Last opened'
                            : 'Open'
                        : membership.lifecycle === 'suspended'
                          ? 'Suspended'
                          : 'Unavailable'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
