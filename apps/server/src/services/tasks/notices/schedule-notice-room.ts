/**
 * Resolve the destination afresh for every system post. Leaving a room revokes its reports.
 * @module services/tasks/notices/schedule-notice-room
 */
import type { Task } from '@dorkos/shared/types';
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../../rooms/room-service.js';
import type { RoomStore } from '../../rooms/room-store.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { DirectChats } from '../../rooms/direct-chat/direct-chats.js';

/** The existing room writer and the live owner lookup, with no turn runner. */
export interface ScheduleNoticeRoomDeps {
  rooms: Pick<RoomService, 'postNotice' | 'handoffs'>;
  store: Pick<RoomStore, 'getRoom' | 'getMember'>;
  authors: Pick<AuthorRegistry, 'resolveAgent'>;
  directChats: Pick<DirectChats, 'ensureForAgent'>;
  /** Check membership and append under one database transaction, including across processes. */
  within: <T>(write: () => T) => T;
  owner: (task: Task) => { path: string | null; name: string; authorId?: string } | null;
}

/** Build a synchronous writer: membership cannot change between checking and appending. */
export function scheduleNoticeRoom(deps: ScheduleNoticeRoomDeps) {
  return (task: Task, body: RoomEntryBody): void =>
    deps.within(() => {
      const owner = deps.owner(task);
      if (!owner) return;
      const authorId =
        owner.authorId ??
        (owner.path ? deps.authors.resolveAgent(owner.path, owner.name).id : null);
      const seat = task.proposedBySessionId
        ? deps.rooms.handoffs.reports.seatOf(task.proposedBySessionId)
        : null;
      if (seat && authorId) {
        const room = deps.store.getRoom(seat.roomId);
        if (room && !room.archived && deps.store.getMember(room.id, authorId)) {
          deps.rooms.postNotice(room.id, body);
          return;
        }
      }
      if (!owner.path) return;
      const dm = deps.directChats.ensureForAgent(owner.path, owner.name);
      const room = deps.store.getRoom(dm.roomId);
      if (room && !room.archived && authorId && deps.store.getMember(room.id, authorId)) {
        deps.rooms.postNotice(room.id, body);
      }
    });
}
