/**
 * Read back WHICH room entry a stored room turn answered (DOR-2113).
 *
 * A room turn's prompt is the post, word for word (`room-turn-runner.ts`), so a
 * transcript that stores only text has nothing in the message itself to say
 * who wrote it — and the app drew another agent's post as the person's own.
 * The `<room_context>` block the turn carried names the room and the entry it
 * answered, in a line DorkOS writes (`idsLine` in `room-context-block.ts`).
 * This reads those two ids back, and nothing more: who wrote the entry is the
 * room's own record, looked up by the server at the wire boundary, never read
 * from the block.
 *
 * **Only a LEADING block counts.** Context blocks are prepended to the words
 * (ADR-0273), so the real `<room_context>` sits in the run of blocks before the
 * message. A post that contains a `<room_context>` of its own comes after that
 * run and is never read. A relay block ends the run, because the text after it
 * is somebody's message rather than more context.
 *
 * The round trip with {@link formatRoomContext} is pinned by a test, so a change
 * to the ids line that this stops reading fails there rather than silently.
 *
 * @module services/session/chat-messages/room-turn-ref
 */
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { HistoryMessage } from '@dorkos/shared/types';

/** The two ids a room turn answered. */
export interface RoomTurnRef {
  /** The room the turn was in. */
  roomId: string;
  /** The entry the turn answered. */
  entryId: string;
}

/** Where the ids line starts. It is in the preamble, ahead of every quoted message. */
const IDS_LINE_START = /^Ids here: /m;

/**
 * The ids line, as `idsLine` writes it on a turn that answers a message. Ids
 * are server-minted and pass through `sanitizeIdentity`, so neither holds a
 * space or a comma. Matched against the FIRST ids line only: on a turn that
 * answers no message the real line has no "answering" clause, and a quoted
 * message further down could carry a line that does.
 */
const IDS_LINE =
  /^Ids here: this room is ([^\s,]+), the message you are answering is ([^\s,]+), and /;

/** Tags a leading run of context may hold before the room block. */
const LEADING_TAGS: ReadonlySet<string> = new Set([
  'system-reminder',
  ...Object.values(CONTEXT_TAG).filter((tag) => tag !== CONTEXT_TAG.relay_context),
]);

/**
 * The room and entry a stored room turn answered, or null when the text is not
 * a room turn (or is one that answered no message, like a welcome-back offer).
 *
 * @param text - A user record's raw text, context blocks included.
 */
export function readRoomTurnRef(text: string): RoomTurnRef | null {
  let pos = skipSpace(text, 0);
  while (text.startsWith('<', pos)) {
    const tagEnd = text.indexOf('>', pos);
    if (tagEnd < 0) return null;
    const tag = text.slice(pos + 1, tagEnd);
    if (!LEADING_TAGS.has(tag)) return null;
    const close = `</${tag}>`;
    const closeAt = text.indexOf(close, tagEnd + 1);
    if (closeAt < 0) return null;
    if (tag === CONTEXT_TAG.room_context) {
      const body = text.slice(tagEnd + 1, closeAt);
      const start = IDS_LINE_START.exec(body);
      const match = start ? IDS_LINE.exec(body.slice(start.index)) : null;
      return match ? { roomId: match[1]!, entryId: match[2]! } : null;
    }
    pos = skipSpace(text, closeAt + close.length);
  }
  return null;
}

/**
 * A plain user message from a stored record, carrying the room entry it
 * answered when it was a room turn. The author is not filled in here: the
 * server does that at the wire boundary from the room's own records.
 *
 * @param id - The record's id.
 * @param raw - The record's raw text, context blocks included.
 * @param content - The words, with the context blocks stripped.
 */
export function userHistoryMessage(id: string, raw: string, content: string): HistoryMessage {
  const ref = readRoomTurnRef(raw);
  return { id, role: 'user', content, ...(ref ? { roomMessage: ref } : {}) };
}

/** The first index at or after `from` that is not whitespace. */
function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}
