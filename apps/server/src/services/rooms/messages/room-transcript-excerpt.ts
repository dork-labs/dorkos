/**
 * Room transcript excerpt for feedback reports (DOR-2108).
 *
 * The room sibling of `lib/transcript-excerpt.ts`. When a report is written in a
 * room and its "This room" chip is on, the client sends `roomId` +
 * `includeTranscript`, and the feedback route calls
 * {@link getRoomTranscriptExcerpt} to build the excerpt SERVER-SIDE. The client
 * never builds, trims or scrubs it; its preview asks this same function.
 *
 * **One room, read as the reporter.** The read goes through
 * `RoomService.listEntries` with the reporter's own author id, so it passes the
 * same visibility gate the room view does: a room they cannot see yields
 * nothing, and no other room is ever touched. Threads stay out, as they do on
 * the room's own timeline.
 *
 * **Bounded twice, newest kept.** Only the last
 * {@link ROOM_TRANSCRIPT_MAX_MESSAGES} messages, then a whole-excerpt cap of
 * {@link ROOM_TRANSCRIPT_MAX_LEN}. A chat excerpt that runs long loses its
 * newest end; a room's oldest end goes instead, because the recent messages are
 * the ones a report is about.
 *
 * **Scrubbed before it leaves the process**, with the same `redactPaths` /
 * `redactTokens` pair the chat excerpt, crash reports and log excerpt use.
 * Attachments are counted, never named: a file name is the room's, not the
 * report's.
 *
 * @module services/rooms/messages/room-transcript-excerpt
 */
import { redactPaths, redactTokens } from '@dorkos/shared/error-report';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import {
  ROOM_TRANSCRIPT_MAX_LEN,
  ROOM_TRANSCRIPT_MAX_MESSAGES,
} from '@dorkos/shared/telemetry-events';

import { getRoomService } from '../index.js';

/** Format one room entry as a readable line. */
function formatEntry(entry: RoomEntry, nameOf: (authorId: string) => string | undefined): string {
  const text = entry.body.text.trim();
  const files = entry.attachments?.length ?? 0;
  const suffix = files > 0 ? ` [${files} attachment${files === 1 ? '' : 's'}]` : '';
  if (entry.kind === 'notice') return `[room notice] ${text}${suffix}`;
  return `${nameOf(entry.authorId) ?? 'Someone'}: ${text}${suffix}`;
}

/**
 * Build a bounded, scrubbed excerpt from a room's latest entries. Pure, so its
 * bounding and scrubbing are testable without a database.
 *
 * @param entries - The room's entries, oldest first.
 * @param nameOf - Turns an author id into the name the room shows for it.
 * @returns The excerpt, or `undefined` when there is nothing to attach.
 */
export function buildRoomTranscriptExcerpt(
  entries: readonly RoomEntry[],
  nameOf: (authorId: string) => string | undefined
): string | undefined {
  if (entries.length === 0) return undefined;

  const recent = entries.slice(-ROOM_TRANSCRIPT_MAX_MESSAGES);
  const joined = recent.map((entry) => formatEntry(entry, nameOf)).join('\n\n');
  const scrubbed = redactTokens(redactPaths(joined)).trim();
  if (!scrubbed) return undefined;

  // One character goes to the ellipsis, so a cut excerpt is exactly the cap.
  return scrubbed.length > ROOM_TRANSCRIPT_MAX_LEN
    ? `…${scrubbed.slice(-(ROOM_TRANSCRIPT_MAX_LEN - 1))}`
    : scrubbed;
}

/**
 * Gather the excerpt for one room, as the reporter sees it.
 *
 * Never throws: a room the reporter cannot see, a room that is gone, or a
 * service that is not up all resolve to `undefined`, so a report still sends
 * without it — best-effort, like the chat excerpt.
 *
 * @param roomId - The room the report was written in.
 * @param viewerAuthorId - The reporter's own room author id.
 * @returns The scrubbed, bounded excerpt, or `undefined`.
 */
export async function getRoomTranscriptExcerpt(
  roomId: string,
  viewerAuthorId: string
): Promise<string | undefined> {
  try {
    const rooms = getRoomService();
    const entries = rooms.listEntries(roomId, viewerAuthorId, {
      limit: ROOM_TRANSCRIPT_MAX_MESSAGES,
    });
    return buildRoomTranscriptExcerpt(
      entries,
      (authorId) => rooms.authorRegistry.getById(authorId)?.displayName
    );
  } catch {
    return undefined;
  }
}
