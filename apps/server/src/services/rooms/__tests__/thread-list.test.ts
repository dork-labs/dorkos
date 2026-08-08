/**
 * The cross-room thread list — the sidebar's Threads section, driven through the
 * REAL service and the REAL store (spec `room-messaging-design` §3).
 *
 * The store is not stubbed because the whole feature IS the query: membership,
 * counts and unread are all derived from the room log on every read, so a fake
 * store would leave nothing under test but a `.map`.
 *
 * Time is frozen and stepped by hand. Two posts in the same millisecond tie on
 * `lastActivityAt`, and this file makes claims about ORDER — so the timestamps
 * have to be a thing the test decides rather than a thing the clock happens to
 * produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { THREAD_PREVIEW_MAX_CHARS } from '@dorkos/shared/room-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

describe('listThreads — every thread the reader is in, across every room', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;
  let ana: string;
  let bo: string;

  /** Move the clock on, so the next post is strictly newer than the last. */
  let clock = Date.parse('2026-07-30T12:00:00.000Z');
  const tick = (): void => {
    clock += 1000;
    vi.setSystemTime(clock);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.parse('2026-07-30T12:00:00.000Z');
    vi.setSystemTime(clock);
    // Silent: every reply in this file is written explicitly, so an agent that
    // answered on its own would add replies no assertion accounts for.
    ({ service, authors, human } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
    }));
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A channel with both agents in it. */
  const channel = (title: string): RoomWithRoster =>
    service.createRoom(
      { kind: 'channel', title, members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );

  /** Post at the top level and answer with the entry id. */
  const post = (roomId: string, authorId: string, text: string): string => {
    tick();
    return service.post(roomId, { authorId, text }).id;
  };

  /** Reply inside a thread. */
  const reply = (roomId: string, authorId: string, rootEntryId: string, text: string): string => {
    tick();
    return service.post(roomId, { authorId, text, replyTo: rootEntryId }).id;
  };

  it('lists a thread the reader replied in, counting everybody else’s replies too', () => {
    // The regression this exists for: a participation test written as a
    // predicate on the reply row filters the rows being COUNTED, so a thread the
    // reader answered once would report one reply and hide the rest.
    const room = channel('Backend');
    const root = post(room.id, ana, 'Deploy is red');
    reply(room.id, human, root, 'looking');
    reply(room.id, ana, root, 'stack trace above');
    reply(room.id, bo, root, 'same here');

    const threads = service.listThreads(human, 50);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      roomId: room.id,
      roomKind: 'channel',
      rootEntryId: root,
      rootAuthorId: ana,
      rootPreview: 'Deploy is red',
      replyCount: 3,
    });
  });

  it('lists a thread the reader STARTED, even having never replied in it', () => {
    const room = channel('Backend');
    const root = post(room.id, human, 'Anyone seen the flake?');
    reply(room.id, ana, root, 'twice today');

    const threads = service.listThreads(human, 50);
    expect(threads.map((t) => t.rootEntryId)).toEqual([root]);
    expect(threads[0]!.replyCount).toBe(1);
  });

  it('leaves out a thread the reader neither started nor replied in', () => {
    const room = channel('Backend');
    const mine = post(room.id, human, 'mine');
    reply(room.id, ana, mine, 'yes');
    const theirs = post(room.id, ana, 'between us');
    reply(room.id, bo, theirs, 'agreed');

    expect(service.listThreads(human, 50).map((t) => t.rootEntryId)).toEqual([mine]);
    // …and the agents each see the one they are in, which is the same rule
    // applied from the other side rather than a special case for the operator.
    expect(service.listThreads(bo, 50).map((t) => t.rootEntryId)).toEqual([theirs]);
  });

  it('leaves out a root with no replies — a message nobody answered is not a thread', () => {
    const room = channel('Backend');
    post(room.id, human, 'standalone');
    expect(service.listThreads(human, 50)).toEqual([]);
  });

  it('orders by most recent activity, across rooms', () => {
    const backend = channel('Backend');
    const design = channel('Design');
    const older = post(backend.id, human, 'older thread');
    reply(backend.id, ana, older, 'first');
    const newer = post(design.id, human, 'newer thread');
    reply(design.id, ana, newer, 'second');

    expect(service.listThreads(human, 50).map((t) => t.rootEntryId)).toEqual([newer, older]);

    // A late reply moves its thread back to the top — the order is the newest
    // REPLY, not when the thread was opened.
    reply(backend.id, bo, older, 'one more thing');
    expect(service.listThreads(human, 50).map((t) => t.rootEntryId)).toEqual([older, newer]);
  });

  it('counts replies above the read cursor as unread, and opening the room clears them', () => {
    const room = channel('Backend');
    const root = post(room.id, human, 'question');
    reply(room.id, ana, root, 'one');
    const second = service.post(room.id, { authorId: bo, text: 'two', replyTo: root });

    expect(service.listThreads(human, 50)[0]!.unreadCount).toBe(2);

    // The room's one read cursor is the thread's cursor too, so reading the room
    // reads its threads. That is the stated trade, not a bug. It also proves the
    // count is measured against the PERSON's cursor, which no longer lives on
    // the membership row (team-room-home §D4).
    service.setReadCursor(room.id, human, second.seq);
    expect(service.listThreads(human, 50)[0]!.unreadCount).toBe(0);
  });

  it('lists nothing at all for a reader who is no longer in the room', () => {
    // Participation implies membership at WRITE time, never at read time. Once
    // somebody is off the roster the thread is not theirs to see: `getRoom`
    // 404s them, so the row would be a dead end even if it were drawn, and the
    // room list already refuses them the room itself by joining on membership.
    // This is that same join, doing that same job.
    const room = channel('Backend');
    const root = post(room.id, ana, 'question');
    reply(room.id, ana, root, 'thinking aloud');
    reply(room.id, human, root, 'answer');
    // Two, not one: unread is measured against the cursor and nothing else, so
    // a reply of your own that the cursor has not passed is counted — exactly
    // as `countUnread` counts it for the room's own badge. One rule, one place.
    expect(service.listThreads(ana, 50)[0]!.unreadCount).toBe(2);

    service.removeMember(room.id, human, ana);
    expect(service.listThreads(ana, 50)).toEqual([]);

    // And it stays gone as the conversation moves on without them — the check
    // is against the roster as it is NOW, not against a membership that was
    // true when the words were written.
    reply(room.id, human, root, 'still here?');
    expect(service.listThreads(ana, 50)).toEqual([]);
  });

  it('leaves out threads in an archived room', () => {
    const room = channel('Backend');
    const root = post(room.id, human, 'question');
    reply(room.id, ana, root, 'answer');
    expect(service.listThreads(human, 50)).toHaveLength(1);

    service.updateRoom(room.id, human, { archived: true });
    expect(service.listThreads(human, 50)).toEqual([]);
  });

  it('truncates a long root to the preview length, and honours the limit', () => {
    const room = channel('Backend');
    const long = 'x'.repeat(THREAD_PREVIEW_MAX_CHARS + 40);
    const first = post(room.id, human, long);
    reply(room.id, ana, first, 'ack');
    const second = post(room.id, human, 'second');
    reply(room.id, ana, second, 'ack');

    const all = service.listThreads(human, 50);
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.rootEntryId === first)!.rootPreview).toBe(
      'x'.repeat(THREAD_PREVIEW_MAX_CHARS)
    );

    // The limit takes the newest, not an arbitrary two.
    expect(service.listThreads(human, 1).map((t) => t.rootEntryId)).toEqual([second]);
  });

  it('names a DM thread by the conversation, with no channel slug to draw', () => {
    // The contract the sidebar row renders from, pinned HERE rather than in a
    // client fixture: a DM has no slug, so `roomTitle` is the only name there
    // is, and a row that reached for a slug would draw a bare `#`. This is the
    // same three fields (`kind`, `slug`, `title`) that `RoomTitle` resolves a
    // room row from, so the thread row and the DM row below it cannot disagree.
    const dm = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const root = post(dm.id, human, 'can you summarise yesterday?');
    reply(dm.id, ana, root, 'here it is');

    const [thread] = service.listThreads(human, 50);
    expect(thread).toMatchObject({
      roomId: dm.id,
      roomKind: 'dm',
      roomSlug: null,
      roomTitle: 'Ana',
      replyCount: 1,
    });
  });

  it('names the room a thread lives in, so a row can say where it is', () => {
    const room = channel('Backend');
    const root = post(room.id, human, 'question');
    reply(room.id, ana, root, 'answer');
    const [thread] = service.listThreads(human, 50);
    expect(thread!.roomTitle).toBe('Backend');
    expect(thread!.roomSlug).toBe('backend');
    expect(thread!.lastActivityAt).toBe(new Date(clock).toISOString());
  });
});
