import { describe, it, expect, beforeEach } from 'vitest';
import { eq, roomMembers, type Db } from '@dorkos/db';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import { RoomError } from '../../room-errors.js';
import { agentLookupFor, createRoomHarness, roomSpec } from '../room-test-harness.js';

import { agentLookup, listingReads } from './room-service.fixtures.js';

describe('RoomService — atomicity, slug reclaim and visibility', () => {
  let db: Db;
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    ({ db, service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('creates no room at all when a seeded member does not exist', () => {
    expect(() =>
      service.createRoom(
        { kind: 'channel', title: 'Backend', members: ['ghost'], agentPaths: [] },
        human
      )
    ).toThrow(RoomError);

    // The failure must leave nothing behind: a committed room would hold the
    // slug and turn the obvious retry into a 409 for a room the caller was told
    // did not exist.
    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);
    expect(service.createRoom(roomSpec('channel', 'Backend'), human).slug).toBe('backend');
  });

  it('writes no entry at all when the reply target does not resolve', () => {
    const room = service.createRoom(roomSpec('channel', 'Backend'), human);
    expect(() =>
      service.post(room.id, { authorId: human, text: 'orphan', replyTo: 'no-such-entry' })
    ).toThrow(RoomError);
    expect(service.listEntries(room.id, human, { limit: 10 })).toEqual([]);
  });

  it('refuses to un-archive a channel whose slug someone else has taken', () => {
    const first = service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(first.id, human, { archived: true });
    service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General II', members: [], agentPaths: [] },
      human
    );

    // Archiving released the slug; un-archiving tries to reclaim it. That is a
    // 409, not a raw UNIQUE violation surfacing as a 500.
    expect(() => service.updateRoom(first.id, human, { archived: false })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );
  });

  it('un-archives happily when nobody took the slug', () => {
    const room = service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(room.id, human, { archived: true });
    expect(service.updateRoom(room.id, human, { archived: false }).archived).toBe(false);
  });

  it('moves a channel’s #slug with its title, because the slug IS its name', () => {
    // A channel row reads `#general`, so a rename that changed only `title`
    // would land in the database and change nothing anybody could see.
    const room = service.createRoom(roomSpec('channel', 'General'), human);
    expect(room.slug).toBe('general');

    const renamed = service.updateRoom(room.id, human, { title: 'Backend questions' });
    expect(renamed.title).toBe('Backend questions');
    expect(renamed.slug).toBe('backend-questions');
  });

  it('refuses a rename onto a slug another live channel holds', () => {
    service.createRoom(roomSpec('channel', 'Backend'), human);
    const other = service.createRoom(roomSpec('channel', 'General'), human);

    expect(() => service.updateRoom(other.id, human, { title: 'Backend' })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );
    // Refused whole: the title must not land while the slug is rejected.
    expect(service.getRoom(other.id, human)?.title).toBe('General');
  });

  it('lets a channel keep its own slug through a cosmetic rename', () => {
    const room = service.createRoom(roomSpec('channel', 'General'), human);
    const renamed = service.updateRoom(room.id, human, { title: 'GENERAL' });
    expect(renamed.title).toBe('GENERAL');
    expect(renamed.slug).toBe('general');
  });

  it('refuses a channel name with nothing sluggable in it', () => {
    const room = service.createRoom(roomSpec('channel', 'General'), human);
    expect(() => service.updateRoom(room.id, human, { title: '!!!' })).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' })
    );
  });

  it('brings an archived channel back under a new name when its old one was taken', () => {
    // The trap this closes: archiving releases a slug (the unique index skips
    // archived rooms), so a live channel can take it while the room is away.
    // Judging the un-archive against the OLD slug refused the rename that was
    // the only way out, and nothing else in the product un-archives a room —
    // so the room was stranded for good.
    const away = service.createRoom(roomSpec('channel', 'Backend'), human);
    service.updateRoom(away.id, human, { archived: true });
    const squatter = service.createRoom(roomSpec('channel', 'Backend'), human);
    expect(squatter.slug).toBe('backend');

    // Coming back under its old name is still refused — that name is taken.
    expect(() => service.updateRoom(away.id, human, { archived: false })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );

    // Coming back under a new one works, because the rename is applied before
    // the un-archive is judged.
    const back = service.updateRoom(away.id, human, {
      archived: false,
      title: 'Backend two',
    });
    expect(back.archived).toBe(false);
    expect(back.slug).toBe('backend-two');
    // …and the channel that took the name is untouched.
    expect(service.getRoom(squatter.id, human)?.slug).toBe('backend');
  });

  it('still refuses an un-archive whose new name is also taken', () => {
    const away = service.createRoom(roomSpec('channel', 'Backend'), human);
    service.updateRoom(away.id, human, { archived: true });
    service.createRoom(roomSpec('channel', 'Backend'), human);
    service.createRoom(roomSpec('channel', 'Frontend'), human);

    expect(() =>
      service.updateRoom(away.id, human, { archived: false, title: 'Frontend' })
    ).toThrow(expect.objectContaining({ code: 'SLUG_TAKEN' }));
    // Refused whole: it is still archived, and still under its own old name.
    const untouched = service.getRoom(away.id, human);
    expect(untouched?.archived).toBe(true);
    expect(untouched?.slug).toBe('backend');
  });

  it('renames a direct message without inventing a slug for it', () => {
    // Only a channel has a name people type; a DM is addressed by who is in it.
    const dm = service.createRoom(roomSpec('dm', 'Ana'), human);
    const renamed = service.updateRoom(dm.id, human, { title: 'Ana and Bo' });
    expect(renamed.title).toBe('Ana and Bo');
    expect(renamed.slug).toBeNull();
  });

  it('shows the operator every room, including ones they never joined', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana and Bo', members: [ana], agentPaths: [] },
      ana
    );

    const listed = service.listRooms(human);
    expect(listed.map((r) => r.id)).toContain(room.id);
    // Not a member, so there is no cursor and therefore no unread number —
    // never the room's whole entry count.
    expect(listed.find((r) => r.id === room.id)?.unreadCount).toBeNull();
  });

  it('reports a real unread count for a room the viewer is in', () => {
    const room = service.createRoom(roomSpec('channel', 'Backend'), human);
    service.post(room.id, { authorId: human, text: 'one' });
    expect(service.listRooms(human).find((r) => r.id === room.id)?.unreadCount).toBe(1);
  });

  it('says whether the viewer has written in a room, and only flips when they do', () => {
    const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
    const listedFor = (viewer: string) =>
      service.listRooms(viewer, { includeArchived: true }).find((r) => r.id === room.id);

    // Joined, present, and silent. Membership is not participation.
    expect(listedFor(human)?.viewerHasPosted).toBe(false);

    // Somebody ELSE writing does not make it the viewer's room.
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    service.post(room.id, { authorId: ana, text: 'morning' });
    expect(listedFor(human)?.viewerHasPosted).toBe(false);
    expect(listedFor(ana)?.viewerHasPosted).toBe(true);

    service.post(room.id, { authorId: human, text: 'hi team' });
    expect(listedFor(human)?.viewerHasPosted).toBe(true);
  });

  it('keeps having posted to the room it was posted in', () => {
    const spoken = service.createRoom(roomSpec('channel', 'Backend'), human);
    const quiet = service.createRoom(roomSpec('channel', 'Design'), human);
    service.post(spoken.id, { authorId: human, text: 'hi team' });

    const posted = new Map(service.listRooms(human).map((r) => [r.id, r.viewerHasPosted]));
    expect(posted.get(spoken.id)).toBe(true);
    expect(posted.get(quiet.id)).toBe(false);
  });

  it('asks the entries table once for the whole list, however many rooms there are', () => {
    // The claim is invisible in the returned value — the same booleans come back
    // either way — so count the statements SQLite is asked to prepare. Pinned
    // against the obvious per-room `EXISTS`, which would grow with the list.
    expect(listingReads('channel', 2, '"room_entries"."author_id"')).toBe(1);
    expect(listingReads('channel', 25, '"room_entries"."author_id"')).toBe(1);
  });

  describe('mentionCount and lastLine', () => {
    it('counts the unread entries that name the viewer, and clears when they read', () => {
      const room = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
      const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      authors.setHandle(human, 'dorian');
      service.post(room.id, { authorId: ana, text: '@dorian can you look?' });
      const last = service.post(room.id, { authorId: ana, text: 'nobody named here' });
      const listed = () => service.listRooms(human).find((r) => r.id === room.id)!;

      expect(listed().unreadCount).toBe(2);
      expect(listed().mentionCount).toBe(1);
      // The agent was not named, so its own count is zero.
      expect(service.listRooms(ana).find((r) => r.id === room.id)?.mentionCount).toBe(0);

      service.setReadCursor(room.id, human, last.seq);
      expect(listed().mentionCount).toBe(0);
    });

    it('carries no mention count for a room the viewer is not in', () => {
      const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      const room = service.createRoom(
        { kind: 'dm', title: 'Ana and Bo', members: [ana], agentPaths: [] },
        ana
      );
      const listed = service.listRooms(human).find((r) => r.id === room.id)!;
      expect(listed.unreadCount).toBeNull();
      expect(listed).not.toHaveProperty('mentionCount');
    });

    it("carries each room's newest top-level line, and null for an empty room", () => {
      const spoken = service.createRoom(roomSpec('channel', 'Backend'), human);
      const quiet = service.createRoom(roomSpec('channel', 'Design'), human);
      service.post(spoken.id, { authorId: human, text: 'first' });
      service.post(spoken.id, { authorId: human, text: 'ship it\non Friday' });

      const lines = new Map(service.listRooms(human).map((r) => [r.id, r.lastLine]));
      expect(lines.get(spoken.id)).toBe('ship it on Friday');
      expect(lines.get(quiet.id)).toBeNull();
    });

    it('never shows a member who is not the owner a line from before they joined', () => {
      const room = service.createRoom(roomSpec('channel', 'Backend'), human);
      service.post(room.id, { authorId: human, text: 'said before Ana arrived' });
      const ana = service.addMember(room.id, human, { agentPath: '/agents/ana' }).authorId;
      const lineFor = (viewer: string) =>
        service.listRooms(viewer).find((r) => r.id === room.id)?.lastLine;

      // The owner reads the whole log; Ana's starts where she joined.
      expect(lineFor(human)).toBe('said before Ana arrived');
      expect(lineFor(ana)).toBeNull();

      service.post(room.id, { authorId: human, text: 'welcome, Ana' });
      expect(lineFor(ana)).toBe('welcome, Ana');
    });

    it('reads every last line in one statement, however many rooms there are', () => {
      expect(listingReads('channel', 2, 'json_each(?) AS wanted')).toBe(1);
      expect(listingReads('channel', 25, 'json_each(?) AS wanted')).toBe(1);
    });
  });

  it("carries each direct message's own roster, so the sidebar can draw who it is with", () => {
    const first = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);
    const second = service.createRoom(roomSpec('dm', 'Bo', ['/agents/bo']), human);

    // Keyed by id and sorted, not positional: both rooms and every member are
    // stamped in the same millisecond, so neither order is a promise.
    const listed = new Map(service.listRooms(human, { kind: 'dm' }).map((r) => [r.id, r]));
    const names = (id: string) =>
      listed
        .get(id)
        ?.participants?.map((p) => p.displayName)
        .sort();
    expect(listed.size).toBe(2);
    expect(names(first.id)).toEqual(['Ana', 'You']);
    expect(names(second.id)).toEqual(['Bo', 'You']);
    const counterpart = listed.get(first.id)?.participants?.find((p) => p.kind === 'agent');
    expect(counterpart?.emoji).toBe('🐙');
    expect(counterpart?.agentRef).toBe(agentAuthorRef('/agents/ana'));
  });

  it('carries no roster for a channel — null, which is not an empty room', () => {
    const channel = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);

    const listed = service.listRooms(human).find((r) => r.id === channel.id);
    expect(listed?.participants).toBeNull();
    // The roster is real, it is just not on the list payload.
    expect(service.getRoom(channel.id, human)?.members).toHaveLength(2);
  });

  it('reads the roster table a fixed number of times, however many DMs there are', () => {
    // "One pass, not one read per room" is not something a returned value can
    // show: the same data comes back either way. So count the statements SQLite
    // is asked to prepare, and pin that the count does not move between 2 and 25.
    expect(listingReads('dm', 2, 'room_members')).toBe(2);
    expect(listingReads('dm', 25, 'room_members')).toBe(2);
  });

  it('orders a roster deterministically, so a DM keeps naming the same agent', () => {
    // Every member of a room created this way is stamped with ONE `joinedAt`,
    // so the whole roster ties and the order is decided entirely by the
    // tiebreak. Without one it falls through to whatever index the planner
    // picked — which `ANALYZE` may change under a running install.
    const dm = service.createRoom(
      roomSpec('dm', 'A crowd', ['/agents/ana', '/agents/bo', '/agents/cy', '/agents/di']),
      human
    );

    // The rule, computed from the stored rows rather than from the answer:
    // oldest membership first, author id breaking the tie.
    const expected = db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, dm.id))
      .all()
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.authorId.localeCompare(b.authorId))
      .map((row) => row.authorId);
    expect(expected).toHaveLength(5);

    const listed = service.listRooms(human).find((r) => r.id === dm.id)?.participants;
    expect(listed?.map((p) => p.id)).toEqual(expected);
    // The open room's header reads the roster by the other path. A reader who
    // saw two different agents for one conversation would distrust both.
    expect(service.getRoom(dm.id, human)?.members.map((m) => m.authorId)).toEqual(expected);
  });

  it('shows an agent only the rooms it belongs to', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const mine = service.createRoom(roomSpec('channel', 'Private'), human);
    const shared = service.createRoom(roomSpec('channel', 'Shared'), human);
    service.addMember(shared.id, human, { agentPath: '/agents/ana' });

    expect(service.listRooms(ana).map((r) => r.id)).toEqual([shared.id]);
    expect(service.getRoom(mine.id, ana)).toBeNull();
    expect(() => service.listEntries(mine.id, ana, { limit: 10 })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('makes the operator join before speaking, even though they can see everything', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const theirs = service.createRoom(
      { kind: 'dm', title: 'Ana only', members: [ana], agentPaths: [] },
      ana
    );

    expect(service.getRoom(theirs.id, human)).not.toBeNull();
    expect(() => service.post(theirs.id, { authorId: human, text: 'hi' })).toThrow(
      expect.objectContaining({ code: 'MEMBER_NOT_FOUND' })
    );
  });

  it('stores an inert response mode for a human, not a restriction', () => {
    const room = service.createRoom(roomSpec('dm', 'Ana'), human);
    expect(room.members.find((m) => m.authorId === human)?.responseMode).toBe('always');
  });
});

describe('RoomService — how an author renders', () => {
  it('carries the agent emoji and a stable handle, and never its directory', () => {
    const { service, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);

    const ana = room.members.find((m) => m.author.kind === 'agent')?.author;
    expect(ana?.emoji).toBe('🐙');
    // The handle is derived from the path, so it survives a rename and a mesh
    // rebuild — but the path itself is not on the wire.
    expect(ana?.agentRef).toBe(agentAuthorRef('/agents/ana'));
    expect(JSON.stringify(ana)).not.toContain('/agents/ana');
  });

  it('refreshes the render cache when the agent gets an emoji it did not have', () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'ana', displayName: 'Ana' } }),
    });
    const first = harness.authors.resolveAgent('/agents/ana', 'Ana');
    expect(first.emoji).toBeNull();

    const refreshed = harness.authors.resolveAgent('/agents/ana', 'Ana', { emoji: '🐙' });
    expect(refreshed.id).toBe(first.id);
    expect(harness.authors.getById(first.id)?.emoji).toBe('🐙');
  });

  it('does not blank the render cache for a caller that only knows the name', () => {
    const harness = createRoomHarness({ agents: agentLookup });
    const seeded = harness.authors.resolveAgent('/agents/ana', 'Ana', { emoji: '🐙' });

    // This is the identity-header path: it carries a display name and nothing else.
    harness.authors.resolveAgent('/agents/ana', 'Ana');
    expect(harness.authors.getById(seeded.id)?.emoji).toBe('🐙');
  });
});
