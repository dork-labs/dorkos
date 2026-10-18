/**
 * Each agent's standing Direct chat (rule S12, DOR-2997): the service, and the
 * one place the server builds and registers it.
 *
 * @module services/rooms/direct-chat
 */
import { setDirectNotesSource } from '../../session/context-assembler.js';
import type { AuthorRegistry } from '../author-registry.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import { DirectChats, type DirectChatRooms, type DirectChatsDeps } from './direct-chats.js';

export { DirectChats, DIRECT_NOTES_LIMIT } from './direct-chats.js';
export type { DirectChat, DirectChatRooms, DirectChatsDeps } from './direct-chats.js';

let active: DirectChats | null = null;

/**
 * Build the Direct chat service over the rooms graph, register it for the
 * routes, and hand turns their notes through it.
 *
 * @param deps.store - The rooms store.
 * @param deps.authors - The author registry.
 * @param deps.rooms - The room service, for opening a DM.
 * @returns The service.
 */
export function wireDirectChats(deps: {
  store: DirectChatsDeps['store'];
  authors: AuthorRegistry;
  rooms: DirectChatRooms;
}): DirectChats {
  const chats = new DirectChats({
    ...deps,
    operator: () => resolveOperatorAuthor(deps.authors),
  });
  active = chats;
  setDirectNotesSource((sessionId) => chats.takeUnseen(sessionId));
  return chats;
}

/** The registered service, or `null` before the rooms graph is wired. */
export function getDirectChats(): DirectChats | null {
  return active;
}
