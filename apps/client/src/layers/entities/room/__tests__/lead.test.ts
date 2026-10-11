import { describe, it, expect } from 'vitest';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { roomLead, type RoomLeadInput } from '../lib/lead';

/** One agent on a roster. */
function agent(displayName: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: `author-${displayName}`,
    responseMode: 'silent',
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id: `author-${displayName}`, kind: 'agent', displayName, handle: null },
    origin: 'local',
  };
}

const CHANNEL: RoomLeadInput = {
  kind: 'channel',
  members: [agent('Kai'), agent('Ravi')],
  leadAuthorId: 'author-Kai',
};

describe('roomLead', () => {
  it('resolves the lead against the roster', () => {
    expect(roomLead(CHANNEL)?.authorId).toBe('author-Kai');
    expect(roomLead({ ...CHANNEL, leadAuthorId: 'author-Gone' })).toBeNull();
  });

  it('gives a direct message no lead', () => {
    expect(roomLead({ ...CHANNEL, kind: 'dm' })).toBeNull();
  });

  it('gives a channel connected to an outside chat no lead, whatever is stored', () => {
    // Red if a bridged channel draws a lead: the server never lets one answer
    // there, so the copy would promise an answer nobody gives.
    const bridged = {
      ...CHANNEL,
      bridge: { visibility: 'public' } as unknown as RoomLeadInput['bridge'],
    };
    expect(roomLead(bridged)).toBeNull();
    expect(roomLead({ ...CHANNEL, bridge: null })?.authorId).toBe('author-Kai');
  });
});
