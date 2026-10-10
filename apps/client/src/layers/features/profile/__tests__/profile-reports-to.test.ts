import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { describeReportsTo, reportsToOptions, selfAccountId } from '../lib/profile-reports-to';

/** A person row; `self` carries the account id the server attaches. */
function person(id: string, self: boolean, accountId?: string): TeamMember {
  return {
    id,
    kind: 'human',
    displayName: 'Dorian',
    handle: null,
    isSelf: self,
    ownerId: null,
    origin: 'local',
    person: { role: null, lastSeenAt: null, ...(accountId ? { accountId } : {}) },
  } as TeamMember;
}

/** An agent row with its mesh id. */
function agent(id: string, name: string): TeamMember {
  return {
    id,
    kind: 'agent',
    displayName: name,
    handle: null,
    isSelf: false,
    ownerId: 'p1',
    origin: 'local',
    agent: { manifestId: id },
  } as unknown as TeamMember;
}

const ROSTER = [
  person('p1', true, 'acct-1'),
  agent('A', 'Atlas'),
  agent('J', 'Juno'),
  agent('B', 'Bea'),
];

describe('describeReportsTo', () => {
  it('reads unset as you, by default', () => {
    expect(describeReportsTo({}, ROSTER)).toEqual({
      label: 'You (default)',
      accountId: 'acct-1',
      isDefault: true,
    });
  });

  it('reads an unset agent made by another agent as that agent, by default', () => {
    expect(describeReportsTo({ createdBy: 'J' }, ROSTER)).toEqual({
      label: 'Juno (default)',
      accountId: 'J',
      isDefault: true,
    });
  });

  it('names an explicit manager, agent or you', () => {
    expect(describeReportsTo({ reportsTo: 'J', createdBy: 'B' }, ROSTER).label).toBe('Juno');
    expect(describeReportsTo({ reportsTo: 'acct-1' }, ROSTER)).toMatchObject({
      label: 'You',
      isDefault: false,
    });
  });

  it('skips a manager the roster no longer has, like the server does', () => {
    expect(describeReportsTo({ reportsTo: 'GONE', createdBy: 'J' }, ROSTER).label).toBe(
      'Juno (default)'
    );
  });
});

describe('reportsToOptions', () => {
  it('lists you first, then the other agents by name, never the agent itself', () => {
    expect(reportsToOptions('A', ROSTER).map((option) => option.label)).toEqual([
      'You',
      'Bea',
      'Juno',
    ]);
  });

  it('offers no "You" when the roster does not carry your account id', () => {
    const roster = [person('p1', true), agent('A', 'Atlas')];
    expect(selfAccountId(roster)).toBeNull();
    expect(reportsToOptions('X', roster).map((option) => option.label)).toEqual(['Atlas']);
  });
});
