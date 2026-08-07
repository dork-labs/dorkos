/**
 * Seeded room + entries for the thread bench (`RoomThreadShowcases`).
 *
 * A small, self-contained cast — one room, one reader, two agents — kept apart
 * from `rooms-showcase-data.ts` because the thread bench cares about a
 * different axis (root/reply/orphan/unread), not the roster states that page
 * already covers. Timestamps are fixed rather than clock-derived for the same
 * reason `entry-actions-showcase-data.ts` fixes its own: a bench whose pixels
 * move between visits cannot be compared against a screenshot.
 *
 * @module dev/showcases/room-thread-showcase-data
 */
import type { AuthorRef, RoomEntry, RoomWithRoster } from '@/layers/entities/room';
import { createRoomAuthor, createRoomMember, createRoomWithRoster } from '../mock-factories';

/** The room every seeded thread lives in. */
export const THREAD_ROOM_ID = 'room-thread-bench';

/** The reader's own author id — the identity `RoomThreadPanel` renders as "you". */
const THREAD_VIEWER_ID = 'author-you';

/** The reader, as the roster holds them. */
const THREAD_VIEWER: AuthorRef = createRoomAuthor({
  id: THREAD_VIEWER_ID,
  displayName: 'You',
});

/** An agent who starts most threads. */
export const THREAD_AGENT_ANA: AuthorRef = {
  id: 'author-ana',
  kind: 'agent',
  displayName: 'Ana',
  color: '#7c9cf5',
  handle: 'ana',
};

/** A second agent, so a thread can show more than one voice. */
export const THREAD_AGENT_KAI: AuthorRef = {
  id: 'author-kai',
  kind: 'agent',
  displayName: 'Kai',
  color: '#c85a6e',
  handle: 'kai',
};

/** The room the panel and reply row are shown against. */
export const THREAD_ROOM: RoomWithRoster = createRoomWithRoster({
  id: THREAD_ROOM_ID,
  slug: 'build',
  title: 'build',
  topic: 'Deploys, breakage, and who is looking at it',
  viewerAuthorId: THREAD_VIEWER_ID,
  members: [
    createRoomMember({ roomId: THREAD_ROOM_ID, author: THREAD_VIEWER }),
    createRoomMember({ roomId: THREAD_ROOM_ID, author: THREAD_AGENT_ANA, responseMode: 'engaged' }),
    createRoomMember({ roomId: THREAD_ROOM_ID, author: THREAD_AGENT_KAI, responseMode: 'engaged' }),
  ],
});

let seq = 0;

/**
 * One seeded room entry, with everything `RoomEntry` requires already filled
 * in.
 *
 * @param text - What the entry says.
 * @param overrides - Anything a particular demo needs to differ — most often
 *   `authorId`, `parentEntryId` and `threadRootEntryId` to place it in a
 *   thread.
 */
export function threadEntry(text: string, overrides: Partial<RoomEntry> = {}): RoomEntry {
  seq += 1;
  const id = `thread-entry-${seq}`;
  return {
    roomId: THREAD_ROOM_ID,
    seq,
    id,
    authorId: THREAD_AGENT_ANA.id,
    kind: 'post',
    body: { text },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T09:45:00.000Z',
    ...overrides,
  };
}

/**
 * A reply hanging off `root`, at the fixed depth threads are (one level).
 *
 * @param root - The entry the reply answers.
 * @param text - What the reply says.
 * @param overrides - Anything else to differ — usually `authorId`.
 */
export function threadReply(
  root: RoomEntry,
  text: string,
  overrides: Partial<RoomEntry> = {}
): RoomEntry {
  return threadEntry(text, {
    parentEntryId: root.id,
    threadRootEntryId: root.id,
    ...overrides,
  });
}

/** The quick row a fresh install offers. */
export const THREAD_REACTION_FREQUENTS = ['👍', '❤️', '🎉'];
