/**
 * A person changing a handle, their own or an agent's (DOR-3156).
 *
 * The write itself is {@link AuthorRegistry.setHandle}; this adds what a rename
 * of an AGENT owes the rooms it is in: one quiet `handle_changed` line in each,
 * naming who renamed it and both handles, so the next mention uses the new one.
 * A person renaming themselves writes no line, as before.
 *
 * **Identity is the author id, never the handle.** Nothing here touches a
 * level, a mark, a grant or a membership: every one of those is keyed on the
 * author or agent id, and every mention already sent was resolved to the id
 * when it was sent. The old handle is tombstoned to the agent by the store, so
 * nobody else can take it and catch the `@` text people still type.
 *
 * @module server/services/rooms/handles/rename-author-handle
 */
import type { AuthorRecord } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import { buildHandleChangedNotice } from '../notices/notice-copy.js';
import { logger } from '../../../lib/logger.js';

/**
 * Set an author's handle as a person, and tell each room an agent is in.
 *
 * @param service - The room service.
 * @param byAuthorId - The person doing it.
 * @param authorId - Whose handle changes.
 * @param raw - The new handle. Empty clears it.
 * @returns The author, with its handle as stored.
 */
export function renameAuthorHandle(
  service: RoomService,
  byAuthorId: string,
  authorId: string,
  raw: string
): AuthorRecord {
  const before = service.authorRegistry.getById(authorId)?.handle ?? null;
  const after = service.authorRegistry.setHandle(authorId, raw);
  if (after.kind === 'agent' && after.handle !== before) {
    announceHandleChange(service, byAuthorId, after, before);
  }
  return after;
}

/**
 * Write the `handle_changed` line in every room the agent is in. A room that
 * refuses it (archived a moment ago) is logged and skipped: the rename has
 * already happened, and one missing line must not undo it.
 */
function announceHandleChange(
  service: RoomService,
  byAuthorId: string,
  agent: AuthorRecord,
  before: string | null
): void {
  const body = buildHandleChangedNotice(
    service.nameForAgents(byAuthorId) ?? 'Somebody',
    agent.displayName,
    agent.id,
    before,
    agent.handle
  );
  for (const { roomId } of service.listMemberRooms(agent.id)) {
    // A mirrored room's log belongs to the community that owns it.
    if (service.isMirroredRoom(roomId)) continue;
    try {
      service.postNotice(roomId, body);
    } catch (error) {
      logger.warn('[rooms] could not write a handle_changed line', { roomId, error });
    }
  }
}
