/**
 * Whether what launched a chat was marked or came from outside, read from what
 * the database keeps (DOR-3106/3107). A chat's own turn marks do not outlive a
 * restart, so this is the durable reading the one-time raise of existing chats
 * goes by. (A NEW chat a message opens is decided by the sender's bound at send
 * time, `senderBound` in `chat-message-ceiling.ts`, DOR-3107.)
 *
 * Unknown is not marked (Dorian 2026-10-19 15:07, Security 15:10): only a mark
 * that was kept, or a source that is outside, counts.
 *
 * - **Any origin that is not our own** (`isOwnLaunchOrigin`): outside.
 * - **A chat another chat's message opened**: marked when the opening message's
 *   stored sender level carries a mark, or its sending chat was itself launched
 *   from outside or, as below, opened by a person during a Wi-Fi sign-in.
 * - **A chat an agent launched** (`session_start`): it must have been started
 *   from a chat (`session_started_by` kind `chat`); a launch with no starting
 *   chat came through the external `/mcp` server or HTTP, unverified, and counts
 *   as outside. Then the same reading of its opening row and starting chat.
 * - **A room turn's chat**: outside unless its room is found, is not bridged to
 *   a chat app, is not a space's copy, holds no post from an author outside this
 *   computer (or with no author record), holds no post whose kept marks carry
 *   one, and holds no post held to the runtime's default (a Wi-Fi sign-in's,
 *   `room_entries.held_to_default`, read only where that column exists). A
 *   superset of the post that started it: entries do not record which one did.
 * - **A chat a person opened** (`interactive`, or no origin recorded): marked
 *   when any Wi-Fi sign-in was live as the chat was made (signed in no later
 *   than the chat was made, and expiring no earlier). A chat is not linked to
 *   the sign-in that opened it, so this errs toward keeping it capped.
 *
 * A Wi-Fi-held turn records its level with the outsider mark, so a chat its
 * message or `session_start` opened reads as marked through the opening row.
 * Tunnel arrival is not stored: a chat opened over the tunnel reads as unknown,
 * which raises.
 *
 * @module services/core/permissions/chat-launch-marks
 */
import {
  authors,
  session as authSession,
  chatMessages,
  communityRoomMirrors,
  roomBridges,
  roomEntries,
  roomSessions,
  sessionMetadata,
  sessionStartedBy,
  type Db,
} from '@dorkos/db';
import { and, asc, eq, gte, isNotNull, isNull, like, lte, ne, or, sql } from 'drizzle-orm';

import { hasMarks, parseStoredMarks } from '../turn-power/turn-marks.js';
import { isOwnLaunchOrigin, openingMessageMarked } from './existing-chats-raise.js';

/** The natural-key prefix of an author outside this computer (`author-registry.ts`). */
const EXTERNAL_AUTHOR_PREFIX = 'platform:';

/** The route a Wi-Fi sign-in's session records (`session.route`, DOR-2969). */
const WIFI_ROUTE = 'wifi';

/**
 * Whether `room_entries` has the `held_to_default` column (DOR-3037), which a
 * database migrated before it lacks. Schema metadata, read once per reader.
 */
function hasHeldToDefaultColumn(db: Db): boolean {
  const columns = db.all<{ name: string }>(sql`PRAGMA table_info(room_entries)`);
  return columns.some((column) => column.name === 'held_to_default');
}

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
  let heldColumn: boolean | undefined;

  /** Whether a room holds a post held to the runtime's default, where that is kept. */
  const roomHoldsHeldPost = (roomId: string): boolean => {
    heldColumn ??= hasHeldToDefaultColumn(db);
    if (!heldColumn) return false;
    return (
      db.get(
        sql`SELECT 1 AS held FROM room_entries
          WHERE room_id = ${roomId} AND held_to_default = 1 LIMIT 1`
      ) !== undefined
    );
  };

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
        .some((row) => hasMarks(parseStoredMarks(row.turnMarks))) ||
      roomHoldsHeldPost(roomId);
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

  /** Whether a Wi-Fi sign-in was live when a chat was made; unknown when it was made is not. */
  const madeDuringWifiSignIn = (sessionId: string): boolean => {
    const row = db
      .select({ createdAt: sessionMetadata.createdAt })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const made = row ? Date.parse(row.createdAt) : NaN;
    if (Number.isNaN(made)) return false;
    const at = new Date(made);
    return (
      db
        .select({ id: authSession.id })
        .from(authSession)
        .where(
          and(
            eq(authSession.route, WIFI_ROUTE),
            lte(authSession.createdAt, at),
            gte(authSession.expiresAt, at)
          )
        )
        .limit(1)
        .get() !== undefined
    );
  };

  /** Whether a chat that sent or started another was itself launched from outside, or over Wi-Fi. */
  const starterOutside = (sessionId: string): boolean => {
    const row = db
      .select({ origin: sessionMetadata.launchOrigin })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const origin = row?.origin ?? null;
    if (!isOwnLaunchOrigin(origin)) return true;
    if (origin === 'room') return roomChatMarked(sessionId);
    return (origin === 'interactive' || origin === null) && madeDuringWifiSignIn(sessionId);
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
      case 'interactive':
      case null:
        return madeDuringWifiSignIn(sessionId);
      default:
        return false;
    }
  };
}
