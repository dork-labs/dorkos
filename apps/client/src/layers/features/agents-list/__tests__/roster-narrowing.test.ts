import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { TeamRosterFilters } from '@/layers/entities/team';
import { narrowAgentsByRoster } from '../lib/roster-narrowing';

/** The shape the table narrows: anything carrying a manifest id. */
function agent(id: string) {
  return { id };
}

function member(over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'kind'>): TeamMember {
  return {
    displayName: over.id,
    handle: null,
    isSelf: false,
    ownerId: null,
    origin: 'local',
    ...over,
  } as TeamMember;
}

const OPERATOR = member({ id: 'person-1', kind: 'human', displayName: 'Dorian', handle: 'dorian' });
const SCOUT = member({ id: 'a1', kind: 'agent', displayName: 'Scout', ownerId: 'person-1' });
const NIGHTLY = member({ id: 'a2', kind: 'agent', displayName: 'Nightly', ownerId: 'person-2' });
const DORKBOT = member({ id: 'a3', kind: 'agent', displayName: 'DorkBot', ownerId: null });

const ROSTER = [OPERATOR, SCOUT, NIGHTLY, DORKBOT];
const AGENTS = [agent('a1'), agent('a2'), agent('a3')];

function filters(over: Partial<TeamRosterFilters> = {}): TeamRosterFilters {
  return { kind: 'all', group: 'none', ...over };
}

describe('narrowAgentsByRoster', () => {
  it('leaves the fleet alone when the page is not driving it', () => {
    // The playground and any caller without a route pass nothing.
    expect(narrowAgentsByRoster(AGENTS, ROSTER, undefined)).toEqual(AGENTS);
  });

  it('shows nothing when the roster is narrowed to people', () => {
    // The table lists agents, so "people only" is honestly zero rows. Showing
    // all 3 while the URL says `kind=people` is the bug this exists to stop.
    expect(narrowAgentsByRoster(AGENTS, ROSTER, filters({ kind: 'people' }))).toEqual([]);
  });

  it('shows every agent under the Agents chip', () => {
    expect(narrowAgentsByRoster(AGENTS, ROSTER, filters({ kind: 'agents' }))).toEqual(AGENTS);
  });

  it('narrows to the agents one person owns', () => {
    expect(narrowAgentsByRoster(AGENTS, ROSTER, filters({ owner: 'person-1' }))).toEqual([
      agent('a1'),
    ]);
  });

  it('drops an unowned agent from an owner filter', () => {
    // DorkBot belongs to the install, not to a person, so it is nobody's.
    const owned = narrowAgentsByRoster(AGENTS, ROSTER, filters({ owner: 'person-2' }));
    expect(owned).toEqual([agent('a2')]);
  });

  it('matches the search box against names and handles', () => {
    expect(narrowAgentsByRoster(AGENTS, ROSTER, filters({ q: 'night' }))).toEqual([agent('a2')]);
  });

  it('combines owner and search', () => {
    expect(
      narrowAgentsByRoster(AGENTS, ROSTER, filters({ owner: 'person-1', q: 'night' }))
    ).toEqual([]);
  });

  it('does not narrow when nothing about an identity was asked', () => {
    // `kind: 'all'` on a list that is entirely agents cannot remove a row, so
    // the roster is never consulted and a stale cache cannot hide a fleet.
    expect(narrowAgentsByRoster(AGENTS, [], filters())).toEqual(AGENTS);
  });

  it('shows the fleet when the roster could not be read', () => {
    // A degraded roster knows nothing about ownership. Hiding every agent
    // because of it would be the opposite of "a roster that cannot say your
    // name should still list your agents".
    expect(narrowAgentsByRoster(AGENTS, [], filters({ owner: 'person-1' }))).toEqual(AGENTS);
    expect(narrowAgentsByRoster(AGENTS, [OPERATOR], filters({ q: 'scout' }))).toEqual(AGENTS);
  });

  it('still shows nothing for people-only on a degraded roster', () => {
    // "This table lists agents" is true whether or not the roster answered.
    expect(narrowAgentsByRoster(AGENTS, [], filters({ kind: 'people' }))).toEqual([]);
  });
});
