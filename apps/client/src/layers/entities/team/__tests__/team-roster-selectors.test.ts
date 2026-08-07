import { describe, it, expect } from 'vitest';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import {
  DEFAULT_TEAM_FILTERS,
  filterTeamMembers,
  findTeamOwner,
  groupTeamByOwner,
  teamMemberLabel,
} from '../lib/team-roster-selectors';

// The two-people / four-agent / two-owner roster (spec §W2.6). Reading it from
// the playground's fixture rather than re-declaring one is deliberate: the
// showcase and these assertions must be describing the same install, or the
// browser pass and the test suite can disagree without either going red.
const roster = MOCK_TEAM_ROSTER;

const ids = (members: { id: string }[]) => members.map((member) => member.id);

describe('filterTeamMembers', () => {
  it('shows every identity by default', () => {
    expect(filterTeamMembers(roster, DEFAULT_TEAM_FILTERS)).toHaveLength(roster.length);
  });

  it('keeps the endpoint order — the operator first, then people, then agents', () => {
    // Order is the server's contract (aggregate-team.ts). A selector that
    // sorted here would silently override a decision made upstream.
    expect(ids(filterTeamMembers(roster, DEFAULT_TEAM_FILTERS))).toEqual(ids(roster));
  });

  it('narrows to people — BOTH of them, not just the operator', () => {
    const people = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, kind: 'people' });
    expect(ids(people)).toEqual(['person-dorian', 'person-miguel']);
  });

  it('narrows to agents', () => {
    const agents = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, kind: 'agents' });
    expect(ids(agents)).toEqual([
      'agent-warden',
      'agent-scout',
      'agent-cartographer',
      'agent-dorkbot',
    ]);
  });

  it('narrows to a person AND the agents they own — not only the agents', () => {
    const mine = filterTeamMembers(roster, {
      ...DEFAULT_TEAM_FILTERS,
      owner: 'person-dorian',
    });
    expect(ids(mine)).toEqual(['person-dorian', 'agent-warden', 'agent-scout']);
  });

  it('narrows to the OTHER person and their agent — the filter is not the operator', () => {
    const theirs = filterTeamMembers(roster, {
      ...DEFAULT_TEAM_FILTERS,
      owner: 'person-miguel',
    });
    expect(ids(theirs)).toEqual(['person-miguel', 'agent-cartographer']);
  });

  it('searches display names case-insensitively', () => {
    const found = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, q: 'scOUt' });
    expect(ids(found)).toEqual(['agent-scout']);
  });

  it('searches handles, with or without the @ someone typed', () => {
    const bare = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, q: 'miguel.telegram' });
    const typed = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, q: '@miguel.telegram' });
    expect(ids(bare)).toEqual(['person-miguel']);
    expect(ids(typed)).toEqual(['person-miguel']);
  });

  it('does not blow up on the row whose handle is null', () => {
    // The bug this pins: `member.handle.toLowerCase()` on a null handle.
    const found = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, q: 'cartographer' });
    expect(ids(found)).toEqual(['agent-cartographer']);
  });

  it('combines the chips, the owner filter and the search', () => {
    const found = filterTeamMembers(roster, {
      kind: 'agents',
      owner: 'person-dorian',
      group: 'none',
      q: 'war',
    });
    expect(ids(found)).toEqual(['agent-warden']);
  });
});

describe('groupTeamByOwner', () => {
  it('builds one cluster per owner — two of them, in roster order', () => {
    const groups = groupTeamByOwner(roster, roster);
    expect(groups.map((group) => group.owner?.id ?? null)).toEqual([
      'person-dorian',
      'person-miguel',
      null,
    ]);
  });

  it('puts each agent under the person it belongs to', () => {
    const groups = groupTeamByOwner(roster, roster);
    expect(ids(groups[0]!.members)).toEqual(['agent-warden', 'agent-scout']);
    expect(ids(groups[1]!.members)).toEqual(['agent-cartographer']);
  });

  it('puts what nobody owns last, and does not repeat a person who heads a cluster', () => {
    const groups = groupTeamByOwner(roster, roster);
    const unowned = groups.at(-1)!;
    expect(unowned.owner).toBeNull();
    // DorkBot belongs to the install. Both people head clusters, so neither is
    // drawn a second time as a card here.
    expect(ids(unowned.members)).toEqual(['agent-dorkbot']);
  });

  it('still names an owner the kind filter removed from view', () => {
    // Narrow to agents: no person is in `members`, but every cluster must
    // still be able to say whose it is.
    const agents = filterTeamMembers(roster, { ...DEFAULT_TEAM_FILTERS, kind: 'agents' });
    const groups = groupTeamByOwner(agents, roster);
    expect(groups.map((group) => group.owner?.displayName ?? null)).toEqual([
      'Dorian',
      'Miguel Ferreira-Santos',
      null,
    ]);
  });

  it('draws no unowned cluster when everything showing belongs to someone', () => {
    const mine = filterTeamMembers(roster, {
      kind: 'agents',
      group: 'manager',
      owner: 'person-dorian',
    });
    const groups = groupTeamByOwner(mine, roster);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.owner?.id).toBe('person-dorian');
  });
});

describe('findTeamOwner', () => {
  it('resolves the person an agent belongs to', () => {
    const cartographer = roster.find((member) => member.id === 'agent-cartographer')!;
    expect(findTeamOwner(cartographer, roster)?.displayName).toBe('Miguel Ferreira-Santos');
  });

  it('resolves nothing for an identity nobody owns', () => {
    const dorkbot = roster.find((member) => member.id === 'agent-dorkbot')!;
    expect(findTeamOwner(dorkbot, roster)).toBeUndefined();
  });
});

describe('teamMemberLabel', () => {
  it('names an identity by its handle when it has one', () => {
    expect(teamMemberLabel(roster[0]!)).toBe('@dorian');
  });

  it('falls back to the display name rather than a bare @', () => {
    const cartographer = roster.find((member) => member.id === 'agent-cartographer')!;
    expect(teamMemberLabel(cartographer)).toBe('Cartographer of the Northern Reaches');
    expect(teamMemberLabel(cartographer)).not.toContain('@');
  });
});
