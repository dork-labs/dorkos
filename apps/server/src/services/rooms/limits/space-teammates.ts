/**
 * Which space posts are a teammate's: written in a space by anyone but this install's owner
 * (DOR-2955). The rules such a turn runs under are in `teammate-turn.ts`.
 *
 * Every author a space mirror imports is an outside author on the `community` platform. The
 * stream bridge knows which of them is this install's owner, and VOUCHES for each owner post it
 * imports ({@link vouchOwnerSpaceEntry}). Everything else from a space is a teammate's, so a
 * post the bridge never saw (one cached before a restart, say) is held to the teammate rules
 * rather than given the owner's. A wrong answer the strict way costs one quiet turn; the other
 * way it hands a teammate the owner's power.
 *
 * In memory and bounded, like `turn-levels.ts`, and for the same reason: forgetting fails closed.
 *
 * @module server/services/rooms/limits/space-teammates
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';

/** The platform every space mirror's authors are stored under (`entry-import.ts`). */
const SPACE_PLATFORM = 'community';

/** How many vouched owner posts are remembered, oldest dropped first. */
export const VOUCHED_ENTRY_MEMORY = 10_000;

const vouched = new Set<string>();

/**
 * Record that this local entry is the owner's own post in a space, so a turn answering it keeps
 * the owner's power. Called by the space stream bridge only, as it imports the post.
 *
 * @param entryId - The local entry the post was imported as.
 */
export function vouchOwnerSpaceEntry(entryId: string): void {
  vouched.delete(entryId);
  vouched.add(entryId);
  if (vouched.size > VOUCHED_ENTRY_MEMORY) {
    const oldest = vouched.values().next().value;
    if (oldest !== undefined) vouched.delete(oldest);
  }
}

/**
 * Whether this entry is a teammate's: written in a space by anyone the bridge did not vouch for
 * as the owner. A person on this machine, an agent here, or a bridged chat is never a teammate.
 *
 * @param authors - The registry holding the stored author records.
 * @param entry - An entry a turn answers.
 */
export function isTeammateEntry(
  authors: AuthorRegistry,
  entry: Pick<RoomEntry, 'id' | 'authorId'>
): boolean {
  const naturalKey = authors.getMany([entry.authorId]).get(entry.authorId)?.naturalKey;
  // An author with no record is already held to a stranger's ceiling (`turn-ceiling.ts`); a
  // space mirror resolves every author it imports, so none of its posts reaches here unresolved.
  if (naturalKey === undefined) return false;
  const origin = authorOrigin(naturalKey);
  if (origin === 'local' || origin.platform !== SPACE_PLATFORM) return false;
  return !vouched.has(entry.id);
}

/**
 * The `teammate` spread a `RoomTurnRequest` takes: present when ANY message the turn answers is a
 * teammate's, because one turn answers them all at one level.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 */
export function teammateOf(
  authors: AuthorRegistry,
  entries: readonly Pick<RoomEntry, 'id' | 'authorId'>[]
): { teammate?: true } {
  return entries.some((entry) => isTeammateEntry(authors, entry)) ? { teammate: true } : {};
}
