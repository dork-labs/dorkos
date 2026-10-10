/**
 * Who may read a room turn's session (spec `audit-trail` §3.4, room row).
 *
 * A room turn's stored origin is just `room`, and a room is not one thing. A
 * team channel is agents working where its members can see; a direct message
 * between a person and an agent is that person's own conversation, and a
 * Telegram or Slack chat bridged into a room is someone talking to an agent
 * from a chat app. So the room, not the origin, decides:
 *
 * | The room the session answers in                                    | Who may read the session      |
 * | ------------------------------------------------------------------ | ----------------------------- |
 * | Bridged from a chat app (any `room_bridges` row, live or archived) | `participants` (the person)   |
 * | A DM with a person among its members                               | `participants` (the person)   |
 * | Any other room: a channel, or a DM between agents                  | the room's agent members      |
 *
 * A person posting in a team channel does not make the channel theirs: the
 * channel is shared, and so is the agent's answer there, but only with the
 * room's members, the same reach search gives an agent over the room's own
 * posts. Membership is checked as it stands now, not from the point the agent
 * joined: a transcript has no room `seq` to cut it at.
 *
 * Read at request time from the binding table (`room_sessions`), which always
 * holds the session's live id (DOR-784), so a renamed session is still found.
 * A session no room binds is absent from the answer; the caller treats that as
 * unknown, and unknown is private.
 *
 * @module server/services/rooms/session-bindings/room-session-visibility
 */
import {
  authors,
  chunked,
  roomBridges,
  roomMembers,
  roomSessions,
  rooms,
  eq,
  inArray,
  type Db,
} from '@dorkos/db';

/** Who may read a room turn's session: the person alone, or these agent accounts. */
export type RoomSessionVisibility = 'participants' | { readonly members: readonly string[] };

/**
 * Who may read each room-bound session in `sessionIds`. The caller keeps the
 * list under SQLite's bound-variable limit.
 *
 * @param db - The database holding the room tables.
 * @param sessionIds - The sessions to classify.
 * @param accountIdOf - An agent's stable audit account id from its home
 *   folder, the id an agent reader is named by (`AccountIds.agentAccountId`).
 * @returns One answer per session a room binds; unbound sessions are absent.
 */
export function resolveRoomSessionVisibility(
  db: Db,
  sessionIds: readonly string[],
  accountIdOf: (agentPath: string) => string
): Map<string, RoomSessionVisibility> {
  const answers = new Map<string, RoomSessionVisibility>();
  if (sessionIds.length === 0) return answers;
  const bound = db
    .select({
      sessionId: roomSessions.sessionId,
      roomId: rooms.id,
      kind: rooms.kind,
      bridgedRoomId: roomBridges.roomId,
    })
    .from(roomSessions)
    .innerJoin(rooms, eq(rooms.id, roomSessions.roomId))
    .leftJoin(roomBridges, eq(roomBridges.roomId, rooms.id))
    .where(inArray(roomSessions.sessionId, [...sessionIds]))
    .all();

  const withAPerson = new Set<string>();
  const agentMembers = new Map<string, string[]>();
  for (const roomIds of chunked([...new Set(bound.map((row) => row.roomId))])) {
    const members = db
      .select({ roomId: roomMembers.roomId, kind: authors.kind, naturalKey: authors.naturalKey })
      .from(roomMembers)
      .innerJoin(authors, eq(authors.id, roomMembers.authorId))
      .where(inArray(roomMembers.roomId, roomIds))
      .all();
    for (const member of members) {
      if (member.kind === 'human') withAPerson.add(member.roomId);
      if (member.kind !== 'agent') continue;
      const list = agentMembers.get(member.roomId) ?? [];
      list.push(accountIdOf(member.naturalKey));
      agentMembers.set(member.roomId, list);
    }
  }

  for (const row of bound) {
    const personal =
      row.bridgedRoomId !== null || (row.kind === 'dm' && withAPerson.has(row.roomId));
    // One id is bound in one room; if that ever stops being true, private wins.
    if (personal) answers.set(row.sessionId, 'participants');
    else if (!answers.has(row.sessionId)) {
      answers.set(row.sessionId, { members: agentMembers.get(row.roomId) ?? [] });
    }
  }
  return answers;
}
