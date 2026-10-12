/**
 * Who posted a room entry, for the room-attached chat that answered it
 * (DOR-2113). The session side asks by room and entry id
 * (`room-message-stamps.ts`) and gets back the room's name and the author as
 * the room's own records hold them.
 *
 * @module services/rooms/room-message-lookup
 */
import type { RoomMessageLookup } from '../../session/chat-messages/room-message-stamps.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { isOwnerVoiceRecord, toAuthorRef, type AuthorRegistry } from '../author-registry.js';
import type { RoomStore } from '../room-store.js';

/**
 * Build the lookup over this process's room store and author registry.
 *
 * The room's name follows `resolveRoomOrigins`: `#slug` for a channel, the
 * title for a direct message. `you` is the same "are these the owner's words"
 * answer the rooms domain gives everywhere else (`isOwnerVoiceRecord`), so a
 * post the person wrote in the room still reads as theirs here.
 *
 * @param store - The room store.
 * @param authors - The author registry.
 * @param ownerUserId - The owner account's user id, or null with no accounts.
 */
export function createRoomMessageLookup(
  store: RoomStore,
  authors: AuthorRegistry,
  ownerUserId: () => string | null = () => readOwnerAccount()?.id ?? null
): RoomMessageLookup {
  return (roomId, entryId) => {
    const room = store.getRoom(roomId);
    const entry = room ? store.getEntryById(roomId, entryId) : null;
    const author = entry ? authors.getById(entry.authorId) : null;
    if (!room || !author) return null;
    const ref = toAuthorRef(author);
    return {
      roomLabel: room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title,
      author: {
        id: ref.id,
        kind: ref.kind,
        displayName: ref.displayName,
        handle: ref.handle,
        ...(ref.emoji ? { emoji: ref.emoji } : {}),
        ...(ref.color ? { color: ref.color } : {}),
        ...(author.kind === 'agent' && author.mintedForManifestId
          ? { agentId: author.mintedForManifestId }
          : {}),
        you: isOwnerVoiceRecord(author, ownerUserId()),
      },
    };
  };
}
