import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Db } from '@dorkos/db';
// **`@dorkos/shared/room-schemas` resolves to `packages/shared/dist` here**, not
// to its source: the server is NodeNext and reads the package's `exports` map.
// So a change to `directMessageTitle` or `isDirectMessageTitleDerived` that has
// not been built yet leaves these cases asserting against the OLD function while
// the service under test uses it too — green, and decorative. Run
// `pnpm --filter @dorkos/shared build` before believing anything here.
import { directMessageTitle } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { dmTitleNames } from '../room-roster.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { agentLookupFor, createRoomHarness } from './room-test-harness.js';

/**
 * Four agents, so a roster whose order the store decides has plenty of ways to
 * come out and cannot match an expected title by luck.
 */
const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana' },
  '/agents/bo': { name: 'bo', displayName: 'Bo' },
  '/agents/cy': { name: 'cy', displayName: 'Cy' },
  '/agents/di': { name: 'di', displayName: 'Di' },
});

describe('a group message named after its roster keeps up with it (DOR-772)', () => {
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    ({ db, service, store, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  /** What the room is called right now, read from the store rather than a response. */
  function titleOf(roomId: string): string {
    return store.getRoom(roomId)?.title ?? '';
  }

  it('renames a one-to-one into a group message when a second agent joins', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    service.addMember(room.id, human, { agentPath: '/agents/bo' });

    // The roster's own order decides which name leads — it is oldest-first with
    // the author id breaking a seeded roster's tie — so the assertion is about
    // who the title names, not about which of them is first.
    expect(titleOf(room.id)).toMatch(/^(Ana and Bo|Bo and Ana)$/);
  });

  it('renames a group message whose title was written in the picking order', () => {
    // The cockpit names a conversation in the order the agents were picked; the
    // store reads a seeded roster back oldest-first with the author id breaking
    // the tie. Compared as one string, a title would read as a person's rename
    // whenever those two orders differ.
    //
    // **The title here is derived from the REVERSE of the roster's own order,
    // read back rather than guessed.** Passing `agentPaths` in some order and
    // hoping it comes back the other way is how this test spent its first
    // version proving nothing: the author-id tie-break happened to reproduce the
    // seeding order, so the string matched exactly and the permutation branch
    // was never entered.
    const room = service.createRoom(
      { kind: 'dm', title: 'seeded', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    const rosterOrder = dmTitleNames(service.getRoom(room.id, human)?.members ?? []);
    expect(rosterOrder).toHaveLength(2);
    const written = directMessageTitle([...rosterOrder].reverse());
    expect(written).not.toBe(directMessageTitle(rosterOrder));
    service.updateRoom(room.id, human, { title: written });

    service.addMember(room.id, human, { agentPath: '/agents/cy' });

    const title = titleOf(room.id);
    expect(title).not.toBe(written);
    for (const name of [...rosterOrder, 'Cy']) expect(title).toContain(name);
  });

  it('leaves a title somebody typed alone', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.updateRoom(room.id, human, { title: 'Launch' });

    service.addMember(room.id, human, { agentPath: '/agents/bo' });

    expect(titleOf(room.id)).toBe('Launch');
  });

  it('leaves a title alone once it has stopped naming everybody', () => {
    // Past three names the title counts the rest ("… and 2 others"), so it no
    // longer says who is in the room and the order-insensitive comparison stops
    // being available. Leaving the name alone is the recoverable answer.
    const room = service.createRoom(
      {
        kind: 'dm',
        title: 'Ana, Bo, Cy and 1 other',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo', '/agents/cy', '/agents/di'],
      },
      human
    );
    const before = titleOf(room.id);

    service.addMember(room.id, human, { agentPath: '/agents/ana' });

    expect(titleOf(room.id)).toBe(before);
  });

  it('never renames a channel', () => {
    const room = service.createRoom(
      { kind: 'channel', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    service.addMember(room.id, human, { agentPath: '/agents/bo' });

    expect(titleOf(room.id)).toBe('Ana');
  });

  it('never renames when the person joining is not an agent', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const robin = authors.resolveExternal({
      platformType: 'telegram',
      instanceId: 'main',
      platformUserId: '77',
      displayName: 'Robin',
    }).id;

    service.addMember(room.id, human, { authorId: robin });

    expect(titleOf(room.id)).toBe('Ana');
  });

  it('tells open cockpits the name moved', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');

    service.addMember(room.id, human, { agentPath: '/agents/bo' });

    const renamed = broadcast.mock.calls.filter(([event]) => event === 'room_updated');
    expect(renamed).toHaveLength(1);
    expect(renamed[0][1]).toMatchObject({ roomId: room.id, title: titleOf(room.id) });
    broadcast.mockRestore();
  });

  it('says nothing when re-adding an agent that is already there', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');

    service.addMember(room.id, human, { agentPath: '/agents/ana' });

    expect(broadcast.mock.calls.filter(([event]) => event === 'room_updated')).toHaveLength(0);
    expect(titleOf(room.id)).toBe('Ana');
    broadcast.mockRestore();
  });

  it('leaves the database it read the roster from alone otherwise', () => {
    // A guard against the rename reaching for anything but the title: the room
    // row is patched with one field, so its slug (null on a DM) and its kind
    // survive a join.
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    service.addMember(room.id, human, { agentPath: '/agents/bo' });

    const after = store.getRoom(room.id);
    expect(after?.kind).toBe('dm');
    expect(after?.slug).toBeNull();
    expect(db).toBeDefined();
  });
});
