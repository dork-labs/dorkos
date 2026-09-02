/**
 * The one sentence three surfaces share when a name was an agent's idea
 * (DOR-1022).
 *
 * The claim worth testing is the three-state read: `undefined` and `null` are
 * DIFFERENT answers on the wire, and collapsing them with `??` — the obvious
 * thing to write — turns every install that predates this field into one
 * claiming DorkBot named its owner.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { nameProvenanceNote } from '../lib/name-provenance';

/** The operator's own roster row, with the person facts under test. */
function selfRow(person: Partial<NonNullable<TeamMember['person']>> = {}): TeamMember {
  return {
    id: 'person-dorian',
    kind: 'human',
    displayName: 'Dorian',
    handle: 'dorian',
    isSelf: true,
    ownerId: null,
    origin: 'local',
    person: { role: null, lastSeenAt: null, ...person },
  };
}

describe('nameProvenanceNote', () => {
  it('names the agent that suggested the name', () => {
    expect(nameProvenanceNote(selfRow({ nameSuggestedBy: 'DorkBot' }))).toBe(
      'Suggested by DorkBot'
    );
  });

  it('says an agent did it when the payload cannot name one', () => {
    // `null` means "an agent wrote this and we cannot say which" — the hint is
    // still worth drawing, so this must not fall through to nothing.
    expect(nameProvenanceNote(selfRow({ nameSuggestedBy: null }))).toBe('Suggested by an agent');
  });

  it('says nothing when the field is absent', () => {
    // The common case, and the one a `??` fallback would get wrong: the person
    // saved the name, or this install has no record of who did.
    expect(nameProvenanceNote(selfRow())).toBeNull();
  });

  it('says nothing for a row that carries no person facts at all', () => {
    const agentRow: TeamMember = {
      id: 'agent-ana',
      kind: 'agent',
      displayName: 'Ana',
      handle: null,
      isSelf: false,
      ownerId: 'person-dorian',
      origin: 'local',
    };
    expect(nameProvenanceNote(agentRow)).toBeNull();
  });
});
