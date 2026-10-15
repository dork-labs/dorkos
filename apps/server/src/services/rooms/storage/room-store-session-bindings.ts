import { rooms, roomSessions, eq, and, inArray } from '@dorkos/db';
import type { GrantedDocTargetBinding } from '../service/room-service-deps.js';
import { logger } from '../../../lib/logger.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original readGrantedDocTargetBinding responsibility after exact constructor-private store recognition. */
export function readGrantedDocTargetBinding(
  opaqueRoomStoreKey: object,
  roomId: string,
  approvedAgentId: string,
  approvedCanonicalSessionId: string,
  approvedRuntime: string
): Readonly<GrantedDocTargetBinding> | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.docTargetBindingReader(
    roomId,
    approvedAgentId,
    approvedCanonicalSessionId,
    approvedRuntime
  );
}

/** Original getRoomSession responsibility after exact constructor-private store recognition. */
export function getRoomSession(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string
): string | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select()
    .from(roomSessions)
    .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
    .get();
  return row?.sessionId ?? null;
}

/** Original listRoomSessions responsibility after exact constructor-private store recognition. */
export function listRoomSessions(
  opaqueRoomStoreKey: object
): Array<{ roomId: string; authorId: string; sessionId: string }> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.db
    .select({
      roomId: roomSessions.roomId,
      authorId: roomSessions.authorId,
      sessionId: roomSessions.sessionId,
    })
    .from(roomSessions)
    .all();
}

/** Original resolveRoomOrigins responsibility after exact constructor-private store recognition. */
export function resolveRoomOrigins(
  opaqueRoomStoreKey: object,
  sessionIds: string[]
): Map<string, { roomLabel: string; roomId: string }> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const result = new Map<string, { roomLabel: string; roomId: string }>();
  if (sessionIds.length === 0) return result;
  const rows = facet.db
    .select({
      sessionId: roomSessions.sessionId,
      roomId: rooms.id,
      kind: rooms.kind,
      slug: rooms.slug,
      title: rooms.title,
    })
    .from(roomSessions)
    .innerJoin(rooms, eq(rooms.id, roomSessions.roomId))
    .where(inArray(roomSessions.sessionId, sessionIds))
    .all();
  for (const row of rows) {
    // Several agents in one room answer with several sessions, so many ids can
    // map to the same room — but one id is bound in at most one place, and the
    // first row for it wins if that ever stops being true.
    if (result.has(row.sessionId)) continue;
    const label = row.kind === 'channel' && row.slug ? `#${row.slug}` : row.title;
    result.set(row.sessionId, { roomLabel: label, roomId: row.roomId });
  }
  return result;
}

/** Original bindRoomSession responsibility after exact constructor-private store recognition. */
export function bindRoomSession(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  sessionId: string,
  createdAt: string
): string {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  facet.db
    .insert(roomSessions)
    .values({ roomId, authorId, sessionId, createdAt })
    .onConflictDoNothing()
    .run();
  return facet.getRoomSession(roomId, authorId) ?? sessionId;
}

/** Original rebindRoomSession responsibility after exact constructor-private store recognition. */
export function rebindRoomSession(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  sessionId: string
): boolean {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const successor = facet.sessionLedger.successorFor(sessionId);
  if (successor !== undefined) {
    logger.warn('[rooms] refused to rebind a room onto a retired session id', {
      roomId,
      authorId,
      retiredSessionId: sessionId,
      canonicalSessionId: successor,
    });
    return false;
  }
  facet.db
    .update(roomSessions)
    .set({ sessionId })
    .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
    .run();
  return true;
}
