/**
 * The stale-post check (DOR-3398): before an agent's `post_to_room` lands, has
 * anybody said something in that room since the agent last read it?
 *
 * On the 0.126.4 release day agents crossed posts in #dorkos more than six times: each wrote
 * from a room it had read minutes earlier, and posted over what had been said
 * since. This makes the re-read a step DorkOS takes rather than a habit it
 * hopes for. When there is something new, the post is NOT delivered; the new
 * messages come back instead, and the agent revises or resends with
 * `confirm: true`.
 *
 * **A re-read, never a refusal.** Nothing is held, nobody is asked, and it is
 * the same at every permission level, Full included: the agent can always
 * confirm. That is why it returns a normal result rather than throwing.
 *
 * **Where "last read" comes from.** The member's stored read cursor, which a
 * room turn's claim advances to the message it answers (the turn's context
 * shows everything up to there), raised by what this module notes on top: a
 * `read_room_history` of the room's newest page, a held post's returned
 * messages, and the agent's own last post. The notes are process memory; a
 * restart falls back to the stored cursor, which can only cost one extra
 * re-read, never a missed one.
 *
 * Only posts by OTHER members count. A notice is the room's own voice, and an
 * agent's own messages are not news to it.
 *
 * `chat_send` needs no twin of this: it already refuses a chat that belongs to
 * a room (`session/chat-messages/chat-target.ts`), so it never posts into one.
 *
 * @module server/services/rooms/messages/room-freshness
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { agentKey } from '../room-claims.js';
import type { RoomService } from '../room-service.js';
import { projectEntry, UNTRUSTED_NOTE } from '../service/room-entry-projection.js';

/** The most unseen messages a held post hands back; the newest are kept. */
export const STALE_POST_SHOWN_MAX = 20;

/** The highest `seq` each `(room, agent)` is known to have read, beyond its cursor. */
const seenThrough = new Map<string, number>();

/**
 * Record that an agent has now read a room up to `seq`. Only ever raises.
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 * @param seq - The newest entry it has now seen.
 */
export function noteSeen(roomId: string, authorId: string, seq: number): void {
  const key = agentKey(roomId, authorId);
  if (seq > (seenThrough.get(key) ?? -1)) seenThrough.set(key, seq);
}

/**
 * Note a `read_room_history` result. Only a read of the room's newest page
 * counts: an older page or one thread says nothing about the latest messages.
 *
 * @param roomId - The room read.
 * @param authorId - The agent that read it.
 * @param opts - The read's paging and thread arguments.
 * @param entries - What it returned.
 */
export function noteHistoryRead(
  roomId: string,
  authorId: string,
  opts: { before?: number | undefined; threadRootEntryId?: string | undefined },
  entries: readonly RoomEntry[]
): void {
  if (opts.before !== undefined || opts.threadRootEntryId !== undefined) return;
  for (const entry of entries) noteSeen(roomId, authorId, entry.seq);
}

/**
 * The posts by other members that landed after the agent last read the room,
 * oldest first, at most {@link STALE_POST_SHOWN_MAX}.
 *
 * Read through {@link RoomService.readHistory}, so membership and the join
 * floor apply exactly as they do to the history tool: a non-member gets the
 * same refusal a post would.
 *
 * @param rooms - The rooms service.
 * @param roomId - The room the agent is about to post in.
 * @param authorId - The agent.
 * @returns The unseen posts; empty when the agent is up to date.
 */
export function unseenPosts(rooms: RoomService, roomId: string, authorId: string): RoomEntry[] {
  const floor = Math.max(
    rooms.readCursorFor(roomId, authorId) ?? -1,
    seenThrough.get(agentKey(roomId, authorId)) ?? -1
  );
  return rooms
    .readHistory(roomId, authorId, { limit: STALE_POST_SHOWN_MAX })
    .filter((entry) => entry.seq > floor && entry.kind === 'post' && entry.authorId !== authorId)
    .reverse();
}

/**
 * Hold an agent's post when the room moved on since it last read it.
 *
 * @param rooms - The rooms service.
 * @param roomId - The room.
 * @param authorId - The agent posting.
 * @returns The tool result to return instead of posting, or `null` to post.
 */
export function holdIfStale(
  rooms: RoomService,
  roomId: string,
  authorId: string
): Record<string, unknown> | null {
  const unseen = unseenPosts(rooms, roomId, authorId);
  if (unseen.length === 0) return null;
  // Handed back now, so they count as read: a revised post goes through.
  for (const entry of unseen) noteSeen(roomId, authorId, entry.seq);
  const count = unseen.length === 1 ? '1 new message' : `${unseen.length} new messages`;
  return {
    posted: false,
    reason: 'new_messages',
    instruction:
      `Not posted: ${count} arrived in this room since you last read it. Read them below. ` +
      'If your message still fits, call post_to_room again with the same text and confirm: true. ' +
      'If it no longer fits, revise it or say nothing.',
    note: UNTRUSTED_NOTE,
    newMessages: unseen.map((entry) => projectEntry(rooms, entry)),
  };
}

/** Forget every note. For tests only. */
export function resetFreshnessForTests(): void {
  seenThrough.clear();
}
