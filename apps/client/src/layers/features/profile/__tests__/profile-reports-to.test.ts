import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { describeReportsTo, reportsToOptions } from '../lib/profile-reports-to';

/** The owner's row, as the server sends it: their account id, and whether they are reading. */
function person(id: string, self: boolean, accountId?: string, isViewer = true): TeamMember {
  return {
    id,
    kind: 'human',
    displayName: 'Dorian',
    handle: null,
    isSelf: self,
    ownerId: null,
    origin: 'local',
    person: {
      role: null,
      lastSeenAt: null,
      ...(accountId ? { accountId, isViewer } : {}),
    },
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

  it('reads every owner alias as the owner', () => {
    expect(describeReportsTo({ reportsTo: 'install:abc' }, ROSTER)).toMatchObject({
      label: 'You',
      accountId: 'acct-1',
    });
    expect(describeReportsTo({ reportsTo: 'owner' }, ROSTER).label).toBe('You');
    expect(describeReportsTo({ createdBy: 'install:abc' }, ROSTER).label).toBe('You (default)');
  });

  it('names the owner, not "You", to someone else reading', () => {
    const roster = [person('p1', true, 'acct-1', false), agent('A', 'Atlas')];
    expect(describeReportsTo({}, roster).label).toBe('Dorian (default)');
    expect(describeReportsTo({ reportsTo: 'acct-1' }, roster).label).toBe('Dorian');
    expect(reportsToOptions('A', roster).map((option) => option.label)).toEqual(['Dorian']);
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

  it('offers no person when the roster does not carry the owner’s account id', () => {
    const roster = [person('p1', true), agent('A', 'Atlas')];
    expect(reportsToOptions('X', roster).map((option) => option.label)).toEqual(['Atlas']);
  });
});
