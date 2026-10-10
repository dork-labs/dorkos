/**
 * The reason logged when a person's post reaches no agent (DOR-2823).
 *
 * @module server/services/rooms/tests/why-nobody
 */
import { describe, it, expect } from 'vitest';
import { whyNobody, type AddressingMember } from '../addressing.js';

const ANA: AddressingMember = {
  authorId: 'ana',
  kind: 'agent',
  responseMode: 'mention-only',
  isEngaged: false,
};
const PERSON: AddressingMember = {
  authorId: 'dorian',
  kind: 'human',
  responseMode: 'always',
  isEngaged: false,
};

function reason(over: Partial<Parameters<typeof whyNobody>[0]> = {}): string {
  return whyNobody({
    entry: { authorId: 'dorian', mentions: [] },
    members: [PERSON, ANA],
    namedUnreachable: [],
    partners: [],
    ...over,
  });
}

describe('why nobody was picked', () => {
  it('says the room has no agents', () => {
    expect(reason({ members: [PERSON] })).toBe('no_agents');
  });
  it('says a name reached nobody', () => {
    expect(reason({ namedUnreachable: ['@gone'] })).toBe('named_unreachable');
  });
  it('says the named agent is set not to answer', () => {
    expect(reason({ entry: { authorId: 'dorian', mentions: ['ana'] } })).toBe(
      'named_not_answering'
    );
  });
  it('says the agent in the conversation only answers @mentions', () => {
    expect(reason({ partners: ['ana'] })).toBe('partner_not_answering');
  });
  it('says there was no conversation to follow', () => {
    expect(reason()).toBe('no_conversation');
  });
});
