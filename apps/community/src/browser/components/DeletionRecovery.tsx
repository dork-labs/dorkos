import { useEffect, useState } from 'react';
import type { CommunityWireMembershipSummary } from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import { CommunityAdministration } from './CommunityAdministration.js';

/** Resolve current membership before exposing the owner's deletion recovery controls. */
export function DeletionRecovery({ communityId }: { communityId: string }) {
  const [membership, setMembership] = useState<CommunityWireMembershipSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    void request<{ memberships: CommunityWireMembershipSummary[] }>(
      new URL('/api/v1/memberships', window.location.origin).href
    )
      .then(({ memberships }) => {
        if (current)
          setMembership(memberships.find((item) => item.communityId === communityId) ?? null);
      })
      .catch((cause: unknown) => {
        if (current) setError(describeError(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [communityId]);
  return (
    <main className="settings" aria-labelledby="deletion-recovery-title">
      <p className="eyebrow">Community settings</p>
      <h1 id="deletion-recovery-title">Deletion status</h1>
      {loading ? (
        <p role="status">Checking your access…</p>
      ) : membership?.role === 'owner' ? (
        <CommunityAdministration
          memberRole={membership.role}
          onChanged={() => undefined}
          onOpenPeople={() => window.location.assign(`/c/${communityId}`)}
        />
      ) : (
        <section className="panel">
          <p role="alert">
            {error || 'Deletion settings are only available to this community’s owner.'}
          </p>
          <a className="button" href="/">
            Back to your communities
          </a>
        </section>
      )}
    </main>
  );
}
