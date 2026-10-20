/**
 * Whether anyone from outside can read a room, so a re-seat's room line and
 * the moved agent's summary name no account (Security Must 7). An account's
 * name is the owner's own business.
 *
 * Two readings, either one enough:
 *
 * - **What the room holds**: a bridge to a chat app, a space's copy, an
 *   outside author's post, a post whose kept marks carry one, or a post held to
 *   the runtime's default (a Wi-Fi sign-in's). The same reading a room turn's
 *   chat is judged by (`roomMarkedReader`).
 * - **Who is in it**: any member who is not the owner's own, so a person who
 *   has not said a word yet still counts. An outside author, an author this
 *   install cannot find, or a person who is not the owner. Agents are the
 *   owner's own.
 *
 * Errs toward hiding: a room it cannot read counts as having outsiders.
 *
 * @module services/rooms/reseat/room-outsiders
 */
import type { Db } from '@dorkos/db';
import { readOwnerAccount } from '../../core/auth/index.js';
import { roomMarkedReader } from '../../core/permissions/chat-launch-marks.js';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';
import type { RoomStore } from '../room-store.js';

/**
 * Build the reader.
 *
 * @param db - The database, for what the room holds.
 * @param store - The room store, for who is in it.
 * @param authors - The author registry, to tell the owner's own from anyone else.
 * @returns Whether a room has anyone from outside in it.
 */
export function roomOutsidersReader(
  db: Db,
  store: Pick<RoomStore, 'listMembers'>,
  authors: Pick<AuthorRegistry, 'getById' | 'isOwner'>
): (roomId: string) => boolean {
  const marked = roomMarkedReader(db);
  return (roomId) => {
    try {
      if (marked(roomId)) return true;
      const ownerId = readOwnerAccount()?.id ?? null;
      return store.listMembers(roomId).some((member) => {
        const author = authors.getById(member.authorId);
        if (author === null || author === undefined) return true;
        if (authorOrigin(author.naturalKey) !== 'local') return true;
        return author.kind === 'human' && !authors.isOwner(author.id, ownerId);
      });
    } catch {
      return true;
    }
  };
}
