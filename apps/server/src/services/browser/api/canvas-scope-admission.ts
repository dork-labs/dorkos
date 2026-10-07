import { and, eq, roomMembers, rooms, sessionMetadata, type Db } from '@dorkos/db';
import type { BrowserAttachment } from '@dorkos/shared/browser-schemas';
import { AuthorRegistry } from '../../rooms/author-registry.js';
import { findOwnerAccount } from '../../core/auth/accounts.js';
import { peekProjector } from '../../session/session-state-projector.js';

/** Original local scope occupancy only. Membership never supplies browser permission. */
export function createBrowserCanvasScopeAdmission(db: Db, authors: AuthorRegistry) {
  const getAuthor = authors.getById.bind(authors),
    isOwner = authors.isOwner.bind(authors);
  return (actorId: string, target: BrowserAttachment): boolean => {
    const actor = getAuthor(actorId);
    if (!actor) return false;
    if (target.kind === 'room') {
      const room = db
        .select({ archived: rooms.archived })
        .from(rooms)
        .where(eq(rooms.id, target.roomId))
        .get();
      if (!room || room.archived) return false;
      return !!db
        .select({ authorId: roomMembers.authorId })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, target.roomId), eq(roomMembers.authorId, actorId)))
        .get();
    }
    const row = db
      .select({ agentPath: sessionMetadata.agentPath })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, target.sessionId))
      .get();
    if (actor.kind === 'human') {
      const owner = findOwnerAccount(db);
      return !!owner && isOwner(actorId, owner.id) && (!!row || !!peekProjector(target.sessionId));
    }
    return actor.kind === 'agent' && !!row?.agentPath && row.agentPath === actor.naturalKey;
  };
}
