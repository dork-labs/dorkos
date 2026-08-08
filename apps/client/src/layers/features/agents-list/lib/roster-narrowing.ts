/**
 * Applying the Team page's roster filters to the fleet table.
 *
 * The table and the cards are two views of one roster, so `?kind=`, `?owner=`
 * and `?q=` have to mean the same thing on both. They used to mean nothing here:
 * the table read only its own FilterBar params, so `/team?view=table&kind=people`
 * listed every agent while the URL claimed people-only. A control that silently
 * does nothing is worse than no control, because the URL keeps promising.
 *
 * The narrowing runs through `filterTeamMembers` — the same function the cards
 * use — rather than a second implementation, so the two views cannot drift.
 *
 * @module features/agents-list/lib/roster-narrowing
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { filterTeamMembers, type TeamRosterFilters } from '@/layers/entities/team';

/**
 * Narrow a fleet to the agents the roster filters admit.
 *
 * Three deliberate refusals to narrow, each one a case where narrowing would
 * hide agents that really are there:
 *
 * 1. **No filters at all** — a caller with no route driving it (the dev
 *    playground) gets its list back untouched.
 * 2. **Nothing identity-shaped was asked** — `kind` alone cannot remove a row
 *    from a list that is entirely agents, so the roster is never consulted and
 *    a roster cache that has not caught up with a fresh registration cannot
 *    make that agent disappear.
 * 3. **The roster could not be read** — a degraded roster knows nothing about
 *    ownership, and emptying the table over it would contradict the whole
 *    degradation contract (§W2.2): a roster that cannot say your name should
 *    still list your agents.
 *
 * `kind: 'people'` is the one case answered without the roster, because "this
 * table lists agents" is true whether or not any source answered.
 *
 * @param agents - The fleet, as the topology returned it.
 * @param members - The whole roster, for resolving ownership and handles.
 * @param filters - What the Team page's controls currently say, if anything.
 */
export function narrowAgentsByRoster<T extends { id: string }>(
  agents: T[],
  members: TeamMember[],
  filters: TeamRosterFilters | undefined
): T[] {
  if (!filters) return agents;
  if (filters.kind === 'people') return [];

  const asksAboutIdentity = filters.owner !== undefined || (filters.q ?? '').trim() !== '';
  if (!asksAboutIdentity) return agents;

  const rosterAgents = members.filter((member) => member.kind === 'agent');
  if (rosterAgents.length === 0) return agents;

  const admitted = new Set(filterTeamMembers(rosterAgents, filters).map((member) => member.id));
  return agents.filter((agent) => admitted.has(agent.id));
}
