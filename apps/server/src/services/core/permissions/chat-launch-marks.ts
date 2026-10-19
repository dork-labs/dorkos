/**
 * Whether what launched a chat was marked or came from outside, read from what
 * the database keeps (DOR-3106/3107). A chat's own turn marks do not outlive a
 * restart, so this is the durable reading, shared by the one-time raise of
 * existing chats and by a new chat a message opens, so the two cannot disagree.
 *
 * Unknown is not marked (Dorian 2026-10-19 15:07, Security 15:10): only a mark
 * that was kept, or a source that is outside, counts.
 *
 * - **Any origin that is not our own** (`isOwnLaunchOrigin`): outside.
 * - **A chat another chat's message opened**: marked when the opening message's
 *   stored sender level carries a mark, or its sending chat was itself launched
 *   from outside.
 * - **A chat an agent launched** (`session_start`): it must have been started
 *   from a chat (`session_started_by` kind `chat`); a launch with no starting
 *   chat came through the external `/mcp` server or HTTP, unverified, and counts
 *   as outside. Then the same reading of its opening row and starting chat.
 * - **A room turn's chat**: outside unless its room is found, is not bridged to
 *   a chat app, is not a space's copy, holds no post from an author outside this
 *   computer (or with no author record), and holds no post whose kept marks
 *   carry one. A superset of the post that started it: entries do not record
 *   which one did.
 *
 * Wi-Fi and tunnel arrival is never stored, so a chat opened over them reads
 * as unknown, which raises.
 *
 * @module services/core/permissions/chat-launch-marks
 */
import {
  authors,
  chatMessages,
  communityRoomMirrors,
  roomBridges,
  roomEntries,
  roomSessions,
  sessionMetadata,
  sessionStartedBy,
  type Db,
} from '@dorkos/db';
import { and, asc, eq, isNotNull, isNull, like, ne, or } from 'drizzle-orm';

import { hasMarks, parseStoredMarks } from '../turn-power/turn-marks.js';
import { isOwnLaunchOrigin, openingMessageMarked } from './existing-chats-raise.js';

/** The natural-key prefix of an author outside this computer (`author-registry.ts`). */
const EXTERNAL_AUTHOR_PREFIX = 'platform:';

/** Whether a chat's launch was marked or came from outside, by session id and launch origin. */
export type ChatLaunchMarked = (sessionId: string, launchOrigin: string | null) => boolean;

/**
 * Build the reader over a database.
 *
 * @param db - The database.
 * @param cacheRooms - Keep each room's answer for the reader's life: right for
 *   the one-time raise, which reads many chats of one room at once; wrong for a
 *   live check, where a room can gain a post at any moment.
 */
export function chatLaunchMarks(db: Db, cacheRooms = false): ChatLaunchMarked {
  const rooms = new Map<string, boolean>();

  /** Whether a room is outside or holds a marked or outside post. */
  const roomMarked = (roomId: string): boolean => {
    const kept = cacheRooms ? rooms.get(roomId) : undefined;
    if (kept !== undefined) return kept;
    const answer =
      db
        .select({ id: roomBridges.roomId })
        .from(roomBridges)
        .where(eq(roomBridges.roomId, roomId))
        .get() !== undefined ||
      db
        .select({ id: communityRoomMirrors.localRoomId })
        .from(communityRoomMirrors)
        .where(eq(communityRoomMirrors.localRoomId, roomId))
        .get() !== undefined ||
      db
        .select({ id: roomEntries.id })
        .from(roomEntries)
        .leftJoin(authors, eq(authors.id, roomEntries.authorId))
        .where(
          and(
            eq(roomEntries.roomId, roomId),
            or(isNull(authors.id), like(authors.naturalKey, `${EXTERNAL_AUTHOR_PREFIX}%`))
          )
        )
        .limit(1)
        .get() !== undefined ||
      db
        .select({ turnMarks: roomEntries.turnMarks })
        .from(roomEntries)
        .where(
          and(
            eq(roomEntries.roomId, roomId),
            isNotNull(roomEntries.turnMarks),
            ne(roomEntries.turnMarks, '{}')
          )
        )
        .all()
        .some((row) => hasMarks(parseStoredMarks(row.turnMarks)));
    if (cacheRooms) rooms.set(roomId, answer);
    return answer;
  };

  /** Whether a room turn's chat is marked: its room, found through its seat. */
  const roomChatMarked = (sessionId: string): boolean => {
    const seat = db
      .select({ roomId: roomSessions.roomId })
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, sessionId))
      .get();
    return seat === undefined || roomMarked(seat.roomId);
  };

  /** Whether a chat that sent or started another was itself launched from outside. */
  const starterOutside = (sessionId: string): boolean => {
    const row = db
      .select({ origin: sessionMetadata.launchOrigin })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const origin = row?.origin ?? null;
    if (!isOwnLaunchOrigin(origin)) return true;
    return origin === 'room' && roomChatMarked(sessionId);
  };

  /** Whether the first message to a chat was marked, or came from an outside chat. */
  const openerMarked = (sessionId: string): boolean => {
    const opener = db
      .select({ ceilingJson: chatMessages.ceilingJson, from: chatMessages.fromSessionId })
      .from(chatMessages)
      .where(eq(chatMessages.toSessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(1)
      .get();
    if (!opener) return false;
    return openingMessageMarked(opener.ceilingJson) || starterOutside(opener.from);
  };

  return (sessionId, launchOrigin) => {
    if (!isOwnLaunchOrigin(launchOrigin)) return true;
    switch (launchOrigin) {
      case 'chat-message':
        return openerMarked(sessionId);
      case 'agent-launch': {
        const started = db
          .select({ kind: sessionStartedBy.kind, by: sessionStartedBy.startedBySessionId })
          .from(sessionStartedBy)
          .where(eq(sessionStartedBy.sessionId, sessionId))
          .get();
        if (started?.kind !== 'chat' || !started.by) return true;
        return openerMarked(sessionId) || starterOutside(started.by);
      }
      case 'room':
        return roomChatMarked(sessionId);
      default:
        return false;
    }
  };
}
