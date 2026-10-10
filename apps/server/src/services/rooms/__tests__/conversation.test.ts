/**
 * Following the conversation (DOR-2823, room-participation spec §9.2).
 *
 * A person's unmentioned post goes to the agent they are talking to in that
 * scope: the one that spoke last, or the one they last named. Over a real
 * {@link RoomStore}, because the rule is a walk over the room log and a fake
 * store would only prove the walk.
 *
 * @module server/services/rooms/tests/conversation
 */
import { describe, it, expect } from 'vitest';
import { authors } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { agentPostWindow, conversationFor, type EngagedWindow } from '../engagement.js';
import { RoomStore } from '../room-store.js';

const ROOM = 'room-1';
const ANA = 'ana';
const BO = 'bo';
const HUMAN = 'dorian';
const SYSTEM = 'system-author';
const AGENTS = new Set([ANA, BO]);

const WINDOW: EngagedWindow = { minutes: 60, posts: 15 };
const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const NOW = new Date(T0);

function minutesAgo(minutes: number): string {
  return new Date(T0 - minutes * 60_000).toISOString();
}

function freshStore(): RoomStore {
  const db = createTestDb();
  db.insert(authors)
    .values({
      id: SYSTEM,
      kind: 'system',
      naturalKey: 'system',
      displayName: 'DorkOS',
      createdAt: minutesAgo(600),
    })
    .run();
  const store = new RoomStore(db);
  store.createRoom(
    {
      id: ROOM,
      kind: 'channel',
      slug: 'general',
      title: 'General',
      topic: null,
      createdAt: minutesAgo(600),
    },
    []
  );
  return store;
}

function write(
  store: RoomStore,
  entry: {
    id: string;
    authorId?: string;
    mentions?: string[];
    threadRootEntryId?: string;
    minutesAgo?: number;
  }
): void {
  store.appendEntry({
    roomId: ROOM,
    id: entry.id,
    authorId: entry.authorId ?? HUMAN,
    kind: 'post',
    body: { text: entry.id },
    mentions: entry.mentions ?? [],
    sessionId: null,
    cascadeRoot: entry.id,
    cascadeDepth: 0,
    parentEntryId: entry.threadRootEntryId ?? null,
    threadRootEntryId: entry.threadRootEntryId ?? null,
    createdAt: minutesAgo(entry.minutesAgo ?? 0),
  });
}

/** Who the newest post in `thread` is for, by conversation. */
function partners(
  store: RoomStore,
  opts: { thread?: string; window?: EngagedWindow } = {}
): string[] | null {
  return (
    conversationFor(
      { store },
      {
        roomId: ROOM,
        threadRootEntryId: opts.thread ?? null,
        isAgentMember: (id) => AGENTS.has(id),
        isPerson: (id) => id === HUMAN,
        window: opts.window ?? WINDOW,
        now: NOW,
      }
    )?.partners ?? null
  );
}

describe('following the conversation', () => {
  it('goes to the agent that spoke last, timed from its reply rather than the mention', () => {
    const store = freshStore();
    // The mention is older than the window; the reply is not. The clock that
    // matters is the agent's own post (six of the twelve real misses).
    write(store, { id: 'ask', mentions: [ANA], minutesAgo: 90 });
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 30 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toEqual([ANA]);
  });

  it('closes once the agent’s last post is older than the window', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 61 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toBeNull();
  });

  it('goes to the agent the person named last, even before it answers', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 5 });
    write(store, { id: 'to-bo', mentions: [BO], minutesAgo: 2 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toEqual([BO]);
  });

  it('treats a post that names an agent as its own anchor', () => {
    const store = freshStore();
    write(store, { id: 'ask', mentions: [ANA, BO] });
    expect(partners(store)).toEqual([ANA, BO]);
  });

  it('ignores a mention of a person, which moves the conversation to nobody', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 5 });
    write(store, { id: 'to-a-person', mentions: ['someone-else'], minutesAgo: 1 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toEqual([ANA]);
  });

  it('is not moved by the room’s own voice', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 5 });
    write(store, { id: 'canvas-update', authorId: SYSTEM, minutesAgo: 4 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toEqual([ANA]);
  });

  it('closes once enough unaddressed posts land on top of the anchor', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 5 });
    for (let i = 0; i < 14; i++) write(store, { id: `chatter-${i}`, minutesAgo: 1 });
    // Fourteen on top, the fifteenth is the one being weighed.
    expect(partners(store)).toEqual([ANA]);
    write(store, { id: 'one-too-many' });
    expect(partners(store)).toBeNull();
  });

  it('keeps a thread and the channel apart', () => {
    const store = freshStore();
    write(store, { id: 'root', minutesAgo: 10 });
    write(store, { id: 'in-thread', authorId: ANA, threadRootEntryId: 'root', minutesAgo: 5 });
    write(store, { id: 'top-level', minutesAgo: 1 });
    expect(partners(store)).toBeNull();
    write(store, { id: 'thread-follow-up', threadRootEntryId: 'root' });
    expect(partners(store, { thread: 'root' })).toEqual([ANA]);
  });

  it('counts a thread root that named the agent', () => {
    const store = freshStore();
    write(store, { id: 'root', mentions: [ANA], minutesAgo: 30 });
    write(store, { id: 'follow-up', threadRootEntryId: 'root' });
    expect(partners(store, { thread: 'root' })).toEqual([ANA]);
  });

  it('never picks an author that is not an agent member', () => {
    const store = freshStore();
    write(store, { id: 'departed', authorId: 'gone-agent', minutesAgo: 1 });
    write(store, { id: 'follow-up' });
    expect(partners(store)).toBeNull();
  });

  it('is off when either ceiling is zero', () => {
    const store = freshStore();
    write(store, { id: 'answer', authorId: ANA, minutesAgo: 1 });
    write(store, { id: 'follow-up' });
    expect(partners(store, { window: { minutes: 0, posts: 15 } })).toBeNull();
    expect(partners(store, { window: { minutes: 60, posts: 0 } })).toBeNull();
  });
});

describe('the window an agent’s post is weighed against', () => {
  it('keeps the old bound when the configured one is longer', () => {
    expect(agentPostWindow({ minutes: 60, posts: 15 })).toEqual({ minutes: 10, posts: 5 });
  });

  it('never outlasts the configured one, so turning it off still does', () => {
    expect(agentPostWindow({ minutes: 0, posts: 0 })).toEqual({ minutes: 0, posts: 0 });
    expect(agentPostWindow({ minutes: 3, posts: 2 })).toEqual({ minutes: 3, posts: 2 });
  });
});
