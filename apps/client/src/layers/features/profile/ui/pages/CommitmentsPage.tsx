/**
 * Commitments — what this agent promised, to whom and by when (spec
 * `heartbeats` §12). Anyone may read any agent's list, so this page is pushed
 * from every agent's profile. On someone else's agent it is facts only, with
 * no controls, like every other row there; on your own agents and DorkBot you
 * can mark one kept, drop it, or add one.
 *
 * @module features/profile/ui/pages/CommitmentsPage
 */
import { useMemo } from 'react';
import { CommitmentList, rosterNameLookup } from '@/layers/features/commitments';
import { deriveRelationship } from '../../lib/profile-relationship';
import type { ProfilePageContentProps } from './types';

/** This agent's commitments: open first, overdue marked, closed folded. */
export function CommitmentsPage({ member, roster }: ProfilePageContentProps) {
  const agentId = member.agent?.manifestId;
  const nameOf = useMemo(() => rosterNameLookup(roster), [roster]);
  const relationship = deriveRelationship(member, roster);
  const yours = relationship === 'managed' || relationship === 'system';
  if (!agentId) return null;
  return (
    <div className="min-h-0 flex-1" data-slot="profile-commitments">
      <CommitmentList agentId={agentId} nameOf={nameOf} canAdd={yours} readOnly={!yours} />
    </div>
  );
}
