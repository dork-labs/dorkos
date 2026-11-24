import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { eventFanOut } from '../../../core/event-fan-out.js';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import type { RoomStore } from '../../room-store.js';
import { createRoomHarness, roomSpec, type RoomHarness } from '../room-test-harness.js';

import { agentLookup } from './room-service.fixtures.js';

describe('RoomService — creating a DM in one call', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('joins the agent named by its directory, seeded from its manifest', () => {
    const room = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);

    const ana = room.members.find((m) => m.author.displayName === 'Ana');
    expect(ana).toBeDefined();
    // A DM seeds from the manifest, which is what makes the agent answer at all.
    expect(ana?.responseMode).toBe('always');
    expect(room.members).toHaveLength(2);
  });

  it('creates no room at all when the agent path resolves to nothing, and the retry works', () => {
    expect(() => service.createRoom(roomSpec('dm', 'Ghost', ['/agents/ghost']), human)).toThrow(
      expect.objectContaining({ code: 'AGENT_NOT_FOUND' })
    );

    // Nothing half-written: no DM named after an agent that is not in it.
    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);

    const retried = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);
    expect(retried.members).toHaveLength(2);
  });

  it('leaves no room behind when the SECOND of two agents is unknown', () => {
    expect(() =>
      service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana', '/agents/ghost']), human)
    ).toThrow(expect.objectContaining({ code: 'AGENT_NOT_FOUND' }));

    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);
    // The slug is free, so the obvious retry is not a 409 for a room the caller
    // was told did not exist.
    expect(service.createRoom(roomSpec('channel', 'Backend'), human).slug).toBe('backend');
  });

  it('does not double-join an agent named twice', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [ana], agentPaths: ['/agents/ana'] },
      human
    );
    expect(room.members.map((m) => m.authorId).sort()).toEqual([human, ana].sort());
  });
});

describe('RoomService — a DM is idempotent on its member set', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  /** Open a direct message with these agents, named after the first of them. */
  function openDm(agentPaths: string[], title = 'Conversation'): string {
    return service.createRoom({ kind: 'dm', title, members: [], agentPaths }, human).id;
  }

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('answers with the conversation you already have, and leaves it where it was', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    const before = service.getRoom(first, human)?.lastActivityAt;
    expect(openDm(['/agents/ana'], 'Ana')).toBe(first);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(1);
    // Opening a conversation is not activity in it. Bumping `lastActivityAt`
    // would float a silent room to the top of a recency-sorted sidebar.
    expect(service.getRoom(first, human)?.lastActivityAt).toBe(before);
  });

  it('reports whether it created the room, which the body cannot say', () => {
    const request = { kind: 'dm' as const, title: 'Ana', members: [], agentPaths: ['/agents/ana'] };
    expect(service.createRoom(request, human).created).toBe(true);
    expect(service.createRoom(request, human).created).toBe(false);
    // A channel never matches an existing room, so it is always a creation.
    expect(service.createRoom(roomSpec('channel', 'Backend'), human).created).toBe(true);
  });

  it('matches whatever order the agents were named in', () => {
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');
    expect(openDm(['/agents/bo', '/agents/ana'], 'Bo and Ana')).toBe(group);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(1);
  });

  it('keeps a one-to-one and a group holding that agent apart', () => {
    // Ana alone and Ana + Bo are different conversations. This is the whole
    // reason the picker may no longer filter out agents that already have a DM.
    const alone = openDm(['/agents/ana'], 'Ana');
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');

    expect(group).not.toBe(alone);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(2);
  });

  it('does not answer with a group when asked for a smaller conversation inside it', () => {
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');
    expect(openDm(['/agents/ana'], 'Ana')).not.toBe(group);
  });

  it('un-archives the conversation instead of minting one beside it', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    const before = service.getRoom(first, human)?.lastActivityAt;
    service.updateRoom(first, human, { archived: true });

    const reopened = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);
    expect(reopened.id).toBe(first);
    expect(reopened.archived).toBe(false);
    expect(reopened.lastActivityAt).toBe(before);
    // One room, and the history is still in it — not stranded in an archived twin.
    expect(service.listRooms(human, { kind: 'dm', includeArchived: true })).toHaveLength(1);
  });

  it('keeps the title, history and roster it already had', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    // Asking for a conversation is not renaming it.
    service.updateRoom(first, human, { title: 'Deploy questions' });
    service.post(first, { authorId: human, text: 'morning' });

    const again = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);
    expect(again.title).toBe('Deploy questions');
    expect(again.members).toHaveLength(2);
    expect(service.listEntries(again.id, human, { limit: 10 }).map((e) => e.body.text)).toEqual([
      'morning',
    ]);
  });

  it('announces nothing on the global stream when no room was created', () => {
    openDm(['/agents/ana'], 'Ana');
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    openDm(['/agents/ana'], 'Ana');

    expect(broadcast.mock.calls.map(([type]) => type)).not.toContain('room_created');
    broadcast.mockRestore();
  });

  it('announces the un-archive, so a stale sidebar hears about it', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    service.updateRoom(first, human, { archived: true });

    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    openDm(['/agents/ana'], 'Ana');
    expect(broadcast).toHaveBeenCalledWith(
      'room_updated',
      expect.objectContaining({ roomId: first, archived: false }),
      expect.any(Function)
    );
    broadcast.mockRestore();
  });

  it('does not dedupe a channel — two channels may hold the same people', () => {
    const first = service.createRoom(roomSpec('channel', 'Backend', ['/agents/ana']), human);
    const second = service.createRoom(roomSpec('channel', 'Frontend', ['/agents/ana']), human);
    expect(second.id).not.toBe(first.id);
  });

  it('does not let an existing DM turn the operator-only seeding rule into a bypass', () => {
    // The refusal comes first, so an agent gets the same 403 whether or not the
    // conversation it named already exists — no probing for one.
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');

    expect(() => service.createRoom(roomSpec('dm', 'Ana and Bo', ['/agents/bo']), ana)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
  });

  it('returns the agent its own DM with the operator rather than a second one', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const first = service.createRoom(
      { kind: 'dm', title: 'Ana and you', members: [human], agentPaths: [] },
      ana
    );
    const again = service.createRoom(
      { kind: 'dm', title: 'Ana and you', members: [human], agentPaths: [] },
      ana
    );
    expect(again.id).toBe(first.id);
  });
});

describe('RoomService — two opens racing for one DM (DOR-1616)', () => {
  let harness: RoomHarness;
  let service: RoomService;
  let store: RoomStore;
  let human: string;

  /**
   * Both member-set lookups miss, and then the real query answers again.
   *
   * **This is the ONE thing stubbed, and it stands in for a clock rather than
   * for a mechanism.** The window being reproduced is unobservable from inside
   * one process: `RoomService.createRoom` is synchronous end to end over
   * `better-sqlite3`, so two calls on one event loop cannot interleave, and the
   * race is reachable only across processes — a second DorkOS server, or a CLI
   * and the app started together (the same window `ensureSystemChannel`
   * documents for `rooms.well_known`). What each of those writers sees is a
   * SELECT that ran before the other one committed, which is exactly a lookup
   * that answers null, and that is what this returns — twice, once per racer.
   *
   * Everything the fix consists of then runs for real: the two inserts, the
   * partial unique index that refuses the second, the re-read that finds the
   * winner, and the adoption. The third call onwards is the unstubbed query, so
   * the recovery is not being fed its answer either.
   */
  function bothCallersLookBeforeEitherWrites(): void {
    vi.spyOn(store, 'findDmByMemberSet').mockReturnValueOnce(null).mockReturnValueOnce(null);
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents: agentLookup });
    ({ service, store, human } = harness);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves ONE room, and hands the loser the winner it lost to', async () => {
    bothCallersLookBeforeEitherWrites();
    const request = { kind: 'dm' as const, title: 'Ana', members: [], agentPaths: ['/agents/ana'] };

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => service.createRoom(request, human)),
      Promise.resolve().then(() => service.createRoom(request, human)),
    ]);

    // The heart of it: one conversation, not two rooms with the same people in
    // them and the sidebar showing both.
    expect(service.listRooms(human, { kind: 'dm', includeArchived: true })).toHaveLength(1);
    expect(second.id).toBe(first.id);
    // And the loser was told which answer it got. Exactly one of the two calls
    // created the room, whichever one won the insert.
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it('answers the loser with a usable room, not a constraint error', async () => {
    // The failure this exists to prevent is not only the duplicate: a raw
    // `SQLITE_CONSTRAINT_UNIQUE` reaching the route would be a 500 telling the
    // caller their DM does not exist while pointing straight at it.
    //
    // **This one is a mutation guard, not a red-before test**, and saying so is
    // the honest note: before DOR-1616 there was no error to surface, so it
    // passed then too. What it discriminates against is the recovery going
    // wrong — a catch that rethrew, or an adopt that answered with a room
    // stripped of its roster.
    bothCallersLookBeforeEitherWrites();
    const request = { kind: 'dm' as const, title: 'Ana', members: [], agentPaths: ['/agents/ana'] };

    const opened = await Promise.all([
      Promise.resolve().then(() => service.createRoom(request, human)),
      Promise.resolve().then(() => service.createRoom(request, human)),
    ]);

    for (const room of opened) {
      expect(room.members).toHaveLength(2);
      expect(room.archived).toBe(false);
      // A room a caller can immediately post into — the point of answering with
      // the winner rather than with an error.
      expect(() => service.post(room.id, { authorId: human, text: 'morning' })).not.toThrow();
    }
  });

  it('un-archives the room the loser adopts, exactly as the matched path does', () => {
    // A racing open whose winner was an ARCHIVED conversation must still come
    // back live. Both halves of the adopt path are the same method, and this is
    // what says so.
    const first = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);
    service.updateRoom(first.id, human, { archived: true });

    // One miss this time: the winner is already in the table, so only the loser
    // is being simulated.
    vi.spyOn(store, 'findDmByMemberSet').mockReturnValueOnce(null);
    const adopted = service.createRoom(roomSpec('dm', 'Ana', ['/agents/ana']), human);

    expect(adopted.id).toBe(first.id);
    expect(adopted.created).toBe(false);
    expect(adopted.archived).toBe(false);
    expect(service.listRooms(human, { kind: 'dm', includeArchived: true })).toHaveLength(1);
  });

  // **What keeps the recovery from swallowing OTHER refusals is tested where it
  // can actually fail**, not here. The obvious service-level assertion — open
  // two channels with one name and expect `SLUG_TAKEN` — cannot reach the catch
  // at all: `createRoom`'s own `findLiveChannelBySlug` guard refuses before the
  // insert is attempted, so that test passes with the guard widened to catch
  // every unique violation, and certifies nothing about it. The narrowness is
  // pinned by `isDmMemberSetTaken`'s own tests in `room-store.test.ts`, driven
  // by real SQLite failures from each of the three unique indexes on `rooms`.
});
