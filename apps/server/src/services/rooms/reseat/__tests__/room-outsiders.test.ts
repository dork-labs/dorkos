/**
 * Security Must 7's reading of a room: a move names accounts only where nobody
 * from outside can read it, counting members who have not said a word yet.
 */
import { describe, expect, it } from 'vitest';
import { agentLookupFor, createRoomHarness } from '../../__tests__/room-test-harness.js';
import { roomOutsidersReader } from '../room-outsiders.js';
import type { AuthorRecord } from '../../author-registry.js';

const AGENTS = agentLookupFor({ '/agents/ana': { name: 'ana' } });

function setup(members: Array<Pick<AuthorRecord, 'id' | 'kind' | 'naturalKey'> | null>) {
  const harness = createRoomHarness({ agents: AGENTS });
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Work', members: [], agentPaths: ['/agents/ana'] },
    harness.human
  );
  const records = new Map<string, AuthorRecord>(
    members.flatMap((m, i) => (m === null ? [] : [[`m${i}`, m as AuthorRecord] as const]))
  );
  const read = roomOutsidersReader(
    harness.db,
    { listMembers: () => members.map((_, i) => ({ authorId: `m${i}` }) as never) },
    {
      getById: (id: string) => records.get(id) ?? null,
      isOwner: (id: string) => id === 'owner',
    } as never
  );
  return { read, roomId: room.id };
}

const owner = { id: 'owner', kind: 'human', naturalKey: 'local' } as const;
const agent = { id: 'agent', kind: 'agent', naturalKey: '/agents/ana' } as const;

describe('roomOutsidersReader', () => {
  it('reads a room of the owner and their agents as having no outsiders', () => {
    const { read, roomId } = setup([owner, agent]);
    expect(read(roomId)).toBe(false);
  });

  it('counts a person who is not the owner, even before they post', () => {
    const { read, roomId } = setup([
      owner,
      agent,
      { id: 'kai', kind: 'human', naturalKey: 'user:kai' },
    ]);
    expect(read(roomId)).toBe(true);
  });

  it('counts an outside author and an author nobody can find', () => {
    expect(
      setup([owner, { id: 'x', kind: 'human', naturalKey: 'platform:telegram:123' }]).read(
        setup([owner]).roomId
      )
    ).toBe(true);
    expect(setup([owner, null]).read(setup([owner]).roomId)).toBe(true);
  });
});
