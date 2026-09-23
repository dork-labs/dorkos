import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CommunityWireMembershipSummary } from '@dorkos/shared/community-wire';
import { describeError, RequestError, request } from '../api.js';

const LAST_COMMUNITY_KEY = 'communityLastAuthorizedId';
const ROUTE_NOTICE_KEY = 'communityChooserNotice';

function readStorage(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    /* Without storage the chooser simply remembers nothing. */
  }
}

/** Remember an authorized canonical selection without treating it as authority. */
export function rememberCommunity(communityId: string): void {
  writeStorage(() => localStorage, LAST_COMMUNITY_KEY, communityId);
}

/**
 * Send the person back to the chooser after a community route they cannot enter.
 *
 * The chooser then says so in one sentence that is the same whether the community was never
 * theirs, they were removed, or it is paused, so the notice reveals nothing about it.
 */
export function returnToChooserWithNotice(): void {
  writeStorage(() => sessionStorage, ROUTE_NOTICE_KEY, 'unavailable');
  window.location.replace('/');
}

function takeRouteNotice(): boolean {
  const notice = readStorage(() => sessionStorage, ROUTE_NOTICE_KEY) === 'unavailable';
  writeStorage(() => sessionStorage, ROUTE_NOTICE_KEY, null);
  return notice;
}

function enterCommunity(communityId: string, replace = false, deletion = false): void {
  rememberCommunity(communityId);
  const path = `/c/${communityId}${deletion ? '/deletion' : ''}`;
  if (replace) window.location.replace(path);
  else window.location.assign(path);
}

/** How one membership row reads and whether choosing it enters anything. */
function describeChoice(membership: CommunityWireMembershipSummary, remembered: boolean) {
  const deletionRecovery =
    membership.lifecycle === 'deletion_pending' && membership.role === 'owner';
  if (deletionRecovery) return { available: true, deletionRecovery, status: 'Review deletion' };
  if (membership.lifecycle === 'archived')
    return { available: true, deletionRecovery, status: 'Read history' };
  if (membership.lifecycle === 'active')
    return { available: true, deletionRecovery, status: remembered ? 'Last opened' : 'Open' };
  if (membership.lifecycle === 'suspended')
    return {
      available: false,
      deletionRecovery,
      status: 'Suspended',
      reason: 'The person running this host has paused it. Your membership is unchanged.',
    };
  return {
    available: false,
    deletionRecovery,
    status: 'Unavailable',
    reason: 'This community cannot be opened right now.',
  };
}

/** Select one of the signed-in account's own memberships at the host root. */
export function CommunityChooser({ signedOut }: { signedOut: () => ReactNode }) {
  const [memberships, setMemberships] = useState<CommunityWireMembershipSummary[] | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [error, setError] = useState('');
  const [hostOperator, setHostOperator] = useState(false);
  const [routeNotice] = useState(takeRouteNotice);
  const [remembered, setRemembered] = useState(() =>
    readStorage(() => localStorage, LAST_COMMUNITY_KEY)
  );
  const [revision, setRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;
    void request<{ memberships: CommunityWireMembershipSummary[] }>('/api/v1/memberships')
      .then(({ memberships: next }) => {
        if (!current) return;
        const last = readStorage(() => localStorage, LAST_COMMUNITY_KEY);
        // A remembered choice is only a convenience: one this account can no longer see is
        // forgotten rather than trusted.
        if (last && !next.some((membership) => membership.communityId === last)) {
          writeStorage(() => localStorage, LAST_COMMUNITY_KEY, null);
          setRemembered(null);
        }
        const recovering = next.find(
          (membership) =>
            membership.communityId === last &&
            membership.lifecycle === 'deletion_pending' &&
            membership.role === 'owner'
        );
        if (recovering) {
          enterCommunity(recovering.communityId, true, true);
          return;
        }
        if (next.length === 1 && next[0].lifecycle === 'active' && !routeNotice) {
          enterCommunity(next[0].communityId, true);
          return;
        }
        setMemberships(next);
        if (next.length === 0)
          void request('/api/v1/host/communities')
            .then(() => current && setHostOperator(true))
            .catch(() => {});
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof RequestError && cause.status === 401) setUnauthenticated(true);
        else setError(describeError(cause));
      });
    return () => {
      current = false;
    };
  }, [revision, routeNotice]);

  // Once the choices (or the reason there are none) appear, start keyboard and screen-reader
  // users at the page heading rather than wherever the loading state left them.
  const ready = memberships !== null || error !== '';
  useEffect(() => {
    if (ready) heading.current?.focus();
  }, [ready]);

  if (unauthenticated) return signedOut();
  if (!ready)
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
        <h1 id="community-chooser-title" ref={heading} tabIndex={-1}>
          Choose a community
        </h1>
        {routeNotice && (
          <p role="status" className="notice mb-4">
            That community is not available to this account.
          </p>
        )}
        {error ? (
          <div role="alert" className="notice error">
            <p className="mb-3">{error}</p>
            <button
              className="button"
              type="button"
              onClick={() => {
                setError('');
                setRevision((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : memberships?.length === 0 ? (
          <div>
            <p className="muted">This account does not have a community membership yet.</p>
            <p className="muted mb-0">
              To join one, open an invitation link from one of its members in this browser.
            </p>
            {hostOperator && (
              <p className="mt-4 mb-0">
                <a href="/host">Host administration</a>
              </p>
            )}
          </div>
        ) : (
          <ul className="stack m-0 list-none p-0" aria-labelledby="community-chooser-title">
            {memberships?.map((membership) => {
              const choice = describeChoice(membership, remembered === membership.communityId);
              const reasonId = `community-choice-${membership.communityId}-reason`;
              return (
                <li key={membership.communityId}>
                  <button
                    type="button"
                    className="button community-choice"
                    aria-disabled={choice.available ? undefined : true}
                    aria-describedby={choice.reason ? reasonId : undefined}
                    onClick={() => {
                      if (choice.available)
                        enterCommunity(membership.communityId, false, choice.deletionRecovery);
                    }}
                  >
                    <span>
                      <strong>{membership.name}</strong>
                      <span className="small muted block">
                        {membership.role} · signed in as {membership.displayName}
                      </span>
                      {choice.reason && (
                        <span id={reasonId} className="small muted block">
                          {choice.reason}
                        </span>
                      )}
                    </span>
                    <span className="small muted">{choice.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
