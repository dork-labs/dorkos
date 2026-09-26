/**
 * What the operator is missing, and the one handle DorkOS may offer them
 * (DOR-677).
 *
 * The claims worth pinning: `You` is not a name, and a handle is only ever
 * OFFERED from a sign-in email — never invented from nothing (spec `handles`
 * §4, DOR-604).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  isOperatorIdentityIncomplete,
  operatorIdentityGaps,
  suggestOperatorHandle,
} from '../lib/operator-identity';

function selfRow(overrides: Partial<TeamMember> = {}, email?: string): TeamMember {
  return {
    id: 'person-self',
    kind: 'human',
    displayName: 'You',
    handle: null,
    isSelf: true,
    ownerId: null,
    origin: 'local',
    person: { role: null, lastSeenAt: null, ...(email ? { email } : {}) },
    ...overrides,
  };
}

function agentRow(id: string, handle: string | null): TeamMember {
  return {
    id,
    kind: 'agent',
    displayName: id,
    handle,
    isSelf: false,
    ownerId: null,
    origin: 'local',
  };
}

describe('operatorIdentityGaps', () => {
  it('counts the `You` placeholder as no name', () => {
    expect(operatorIdentityGaps(selfRow())).toEqual({ name: true, handle: true });
  });

  it('sees a chosen name and a handle as complete', () => {
    const self = selfRow({ displayName: 'Dorian', handle: 'dorian' });
    expect(operatorIdentityGaps(self)).toEqual({ name: false, handle: false });
    expect(isOperatorIdentityIncomplete(self)).toBe(false);
  });

  it('is incomplete when only the handle is missing', () => {
    expect(isOperatorIdentityIncomplete(selfRow({ displayName: 'Dorian' }))).toBe(true);
  });

  it('is incomplete when only the name is missing', () => {
    expect(isOperatorIdentityIncomplete(selfRow({ handle: 'dorian' }))).toBe(true);
  });
});

describe('suggestOperatorHandle', () => {
  it('offers the email localpart, made legal', () => {
    const self = selfRow({}, 'Dorian.Collier@example.com');
    expect(suggestOperatorHandle(self, [self])).toBe('dorian.collier');
  });

  it('offers nothing without an email — no handle is invented', () => {
    const self = selfRow({ displayName: 'Dorian' });
    expect(suggestOperatorHandle(self, [self])).toBe('');
  });

  it('steps around a handle somebody else on the roster already has', () => {
    const self = selfRow({}, 'dorian@example.com');
    const roster = [self, agentRow('agent-a', 'Dorian')];
    expect(suggestOperatorHandle(self, roster)).toBe('dorian-2');
  });

  it('never suggests a handle the server holds back (DOR-677)', () => {
    // `everyone@…` and `dorkos@…` are real mailboxes; offering `@everyone`
    // would only earn the person a refusal the moment they press save.
    expect(suggestOperatorHandle(selfRow({}, 'everyone@example.com'), [])).toBe('everyone-2');
    expect(suggestOperatorHandle(selfRow({}, 'dorkos@example.com'), [])).toBe('dorkos-2');
  });

  it('never counts the operator’s own current handle as taken', () => {
    const self = selfRow({ handle: 'dorian' }, 'dorian@example.com');
    expect(suggestOperatorHandle(self, [self])).toBe('dorian');
  });

  it('offers nothing when the localpart cannot spell a handle', () => {
    const self = selfRow({}, '_@example.com');
    expect(suggestOperatorHandle(self, [self])).toBe('');
  });
});
