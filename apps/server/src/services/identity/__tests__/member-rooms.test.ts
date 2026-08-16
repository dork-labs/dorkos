/**
 * "Which rooms is this member in?" — over the real `authors` table and the real
 * room store, because the whole question is a join between the two id spaces the
 * roster straddles (spec `profile-unification` §3.2).
 *
 * A person's roster id IS their author row id. An agent's is its manifest ULID,
 * and its author row is found by the generation stamp — so the two cases reach
 * the same membership read down different paths, and a test with a fake author
 * source would prove neither.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { AuthorRegistry } from '../../rooms/author-registry.js';
import { RoomStore } from '../../rooms/room-store.js';
import { listMemberRooms, type MemberRoomsSources } from '../member-rooms.js';

const ANA_MANIFEST = 'ULID_ANA';
const DORKBOT_MANIFEST = 'ULID_DORKBOT';

describe('listMemberRooms', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let store: RoomStore;
  let personId: string;
  let anaAuthorId: string;
  let dorkbotAuthorId: string;

  /** An agent author row with its generation stamp, minted directly. */
  function agentAuthor(id: string, path: string, manifestId: string): string {
    db.insert(authors)
      .values({
        id,
        kind: 'agent',
        naturalKey: path,
        displayName: id,
        mintedForManifestId: manifestId,
        createdAt: '2026-08-01T00:00:00.000Z',
      })
      .run();
    return id;
  }

  /**
   * A room with a roster. Each call is one minute newer than the last, so the
   * order the store promises — newest activity first — is the reverse of the
   * order they were written here, and a test can tell the two apart.
   */
  let created = 0;
  function room(
    id: string,
    title: string,
    memberIds: string[],
    kind: 'channel' | 'dm' = 'channel'
  ) {
    created += 1;
    store.createRoom(
      {
        id,
        kind,
        slug: kind === 'channel' ? id : null,
        title,
        topic: null,
        workspaceId: null,
        createdAt: `2026-08-01T00:0${created}:00.000Z`,
      },
      memberIds.map((authorId) => ({
        authorId,
        responseMode: 'engaged' as const,
        joinedAt: '2026-08-01T00:00:00.000Z',
      }))
    );
  }

  function sources(overrides: Partial<MemberRoomsSources> = {}): MemberRoomsSources {
    return {
      listPeople: () => registry.listActive('human'),
      listAgentAuthors: () => registry.listActive('agent'),
      listRoomsForAuthor: (authorId) => store.listRoomsForMember(authorId),
      listMembersForRooms: (roomIds) => store.listMembersForRooms(roomIds),
      isRegisteredAgent: () => false,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    store = new RoomStore(db);
    created = 0;
    personId = registry.bindOwner('user-1').id;
    anaAuthorId = agentAuthor('author-ana', '/work/ana', ANA_MANIFEST);
    dorkbotAuthorId = agentAuthor('author-dorkbot', '/dork/dorkbot', DORKBOT_MANIFEST);
  });

  it('lists a person’s rooms by their author id, with the roster size', () => {
    room('team', 'Team', [personId, anaAuthorId, dorkbotAuthorId]);
    room('side', 'Side quest', [personId, anaAuthorId]);

    const result = listMemberRooms(personId, sources());

    expect(result).toEqual({
      rooms: [
        { id: 'side', name: 'Side quest', slug: 'side', kind: 'channel', memberCount: 2 },
        { id: 'team', name: 'Team', slug: 'team', kind: 'channel', memberCount: 3 },
      ],
    });
  });

  it('resolves an agent through its manifest ULID, not its author id', () => {
    room('team', 'Team', [personId, anaAuthorId]);
    room('alone', 'Just Dorkbot', [dorkbotAuthorId]);

    expect(listMemberRooms(ANA_MANIFEST, sources())).toEqual({
      rooms: [{ id: 'team', name: 'Team', slug: 'team', kind: 'channel', memberCount: 2 }],
    });
    // And the author id itself is NOT a member id: the roster never hands one
    // out, so accepting it here would be a second id space nothing produces.
    expect(listMemberRooms(anaAuthorId, sources())).toBeNull();
  });

  it('resolves a system agent the same way as any other', () => {
    room('team', 'Team', [personId, dorkbotAuthorId]);

    expect(listMemberRooms(DORKBOT_MANIFEST, sources())).toEqual({
      rooms: [{ id: 'team', name: 'Team', slug: 'team', kind: 'channel', memberCount: 2 }],
    });
  });

  it('gives a direct message its kind and no slug', () => {
    // A DM has no address to print after a `#`, so `slug` is null and the
    // renderer falls back to the title — the same branch `roomName` takes.
    room('dm-1', 'Ana', [personId, anaAuthorId], 'dm');

    expect(listMemberRooms(personId, sources())?.rooms[0]).toEqual({
      id: 'dm-1',
      name: 'Ana',
      slug: null,
      kind: 'dm',
      memberCount: 2,
    });
  });

  it('carries a channel’s slug, which is not its title', () => {
    // The reason the slug travels at all: the cockpit prints `#general` from
    // this field, never from the name. Red if the service ever maps
    // `slug: room.title`.
    room('general', 'General chat', [personId]);

    expect(listMemberRooms(personId, sources())?.rooms[0]).toMatchObject({
      name: 'General chat',
      slug: 'general',
    });
  });

  it('leaves archived rooms out', () => {
    room('team', 'Team', [personId]);
    room('old', 'Old news', [personId]);
    store.updateRoom('old', { archived: true });

    expect(listMemberRooms(personId, sources())?.rooms.map((r) => r.id)).toEqual(['team']);
  });

  it('answers an empty list — not a 404 — for a member in no rooms', () => {
    expect(listMemberRooms(personId, sources())).toEqual({ rooms: [] });
  });

  it('answers an empty list for a registered agent that has no author row yet', () => {
    // An agent gets its author row the first time it is in a room, so a freshly
    // registered one has none. It is still on the roster, so its profile must
    // read "no rooms" rather than "no such member".
    const fresh = 'ULID_FRESH';
    expect(listMemberRooms(fresh, sources({ isRegisteredAgent: (id) => id === fresh }))).toEqual({
      rooms: [],
    });
  });

  it('answers null for an id this install has never heard of', () => {
    expect(listMemberRooms('nobody', sources())).toBeNull();
  });

  it('never resolves a retired agent author', () => {
    // The row a directory left behind when it changed hands. Its stamp names an
    // occupant that is gone, and `listActive` is what keeps it out.
    db.update(authors)
      .set({ retiredAt: '2026-08-05T00:00:00.000Z' })
      .where(eq(authors.id, anaAuthorId))
      .run();
    room('team', 'Team', [personId, anaAuthorId]);

    expect(listMemberRooms(ANA_MANIFEST, sources())).toBeNull();
  });
});
