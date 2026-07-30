/**
 * Seeded room entries for the entry-actions bench.
 *
 * Static and fully local — no transport, no query, no SSE. `useEntryActions`
 * reaches only for two Zustand stores and the clipboard, so a room row renders
 * truthfully with nothing behind it, and the bench stays usable when no server
 * is running at all.
 *
 * Timestamps are fixed rather than `Date.now()`-derived so the clock a row
 * draws is the same on every load — a bench whose pixels move between visits
 * cannot be compared against a screenshot.
 */
import type { MessageAuthor } from '@/layers/shared/model';
import type { AuthorRef, RoomEntry } from '@/layers/entities/room';

/** The room every seeded entry belongs to. */
export const BENCH_ROOM_ID = 'bench-room';

/** The reader's own author id, so a row can be "yours" or "someone else's". */
export const BENCH_VIEWER_ID = 'author-you';

/** An agent in the room — someone the reader can mention. */
export const BENCH_AGENT: MessageAuthor = {
  kind: 'agent',
  id: 'author-ana',
  displayName: 'Ana',
  color: '#7c9cf5',
};

/** The reader, as their own messages draw them. */
export const BENCH_VIEWER: MessageAuthor = {
  kind: 'human',
  id: BENCH_VIEWER_ID,
  displayName: 'You',
  color: '#8b8b8b',
};

/** The agent as the roster holds them — the shape that carries `mentionHandle`. */
export const BENCH_AGENT_REF: AuthorRef = {
  id: BENCH_AGENT.id,
  kind: 'agent',
  displayName: BENCH_AGENT.displayName,
  color: BENCH_AGENT.color,
  mentionHandle: 'ana',
};

/** The reader as the roster holds them. Never offered a mention of themselves. */
export const BENCH_VIEWER_REF: AuthorRef = {
  id: BENCH_VIEWER_ID,
  kind: 'human',
  displayName: BENCH_VIEWER.displayName,
  mentionHandle: 'you',
};

let seq = 0;

/**
 * One seeded entry, with everything a `RoomEntry` requires already filled in.
 *
 * @param text - What the entry says.
 * @param overrides - Anything a particular demo needs to differ.
 * @returns A complete entry, safe to hand straight to `RoomEntryRow`.
 */
export function benchEntry(text: string, overrides: Partial<RoomEntry> = {}): RoomEntry {
  seq += 1;
  const id = `bench-entry-${seq}`;
  return {
    roomId: BENCH_ROOM_ID,
    seq,
    id,
    authorId: BENCH_AGENT.id,
    kind: 'post',
    body: { text },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T10:42:00.000Z',
    ...overrides,
  };
}

/**
 * A message taller than any window, for the sticky rail.
 *
 * Separate paragraphs rather than one long run: a wrapped run's height is at
 * the mercy of the column's width, and this has to overflow the bench's
 * scroller at every width the page is read at.
 */
export const TALL_TEXT = [
  'The deploy has been stuck for twenty minutes. Here is everything the run printed, in order, so nobody has to go and fetch it.',
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `step ${i + 1} — resolving workspace dependencies, then building the affected packages`
  ),
  'That is the whole log. The last step never returned.',
].join('\n\n');
