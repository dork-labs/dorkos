/**
 * What this identity is *to you* — the one derived fact the whole profile
 * branches on (spec `profile-unification` §1.1).
 *
 * @module features/profile/lib/profile-relationship
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';

/**
 * How the viewer stands to the identity being drawn.
 *
 * Five values, not the six states the design sheet shows, because two of them
 * differ by `kind` rather than by relationship: `other` covers **another
 * person** and **someone else's agent**, which see the same amount (nothing
 * private) and differ only in which facts they have. Every consumer that cares
 * reads `member.kind` beside this, and the row table (§1.4) is written that way.
 */
export type ProfileRelationship = 'self' | 'system' | 'managed' | 'bridged' | 'other';

/**
 * Derive the relationship from the roster row and the roster it came from.
 *
 * The order is the spec's and is load-bearing: your own row wins over
 * everything, a system agent belongs to the install rather than to whoever the
 * server attributed it to, and an agent you own is `managed` even though its
 * owner is also `local`.
 *
 * @param member - The identity being drawn.
 * @param roster - The whole roster, for finding whose install this is.
 * @returns Which of the five relationships holds.
 */
export function deriveRelationship(member: TeamMember, roster: TeamMember[]): ProfileRelationship {
  if (member.isSelf) return 'self';
  if (member.agent?.isSystem) return 'system';
  const selfId = roster.find((row) => row.isSelf)?.id ?? null;
  if (member.kind === 'agent' && selfId !== null && member.ownerId === selfId) return 'managed';
  if (member.origin !== 'local') return 'bridged';
  return 'other';
}
