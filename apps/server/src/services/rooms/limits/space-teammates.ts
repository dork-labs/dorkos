/**
 * Which space posts are a teammate's: written in a space by anyone but this install's owner
 * (DOR-2955). The rules such a turn runs under are in `teammate-turn.ts`.
 *
 * Every author a space mirror imports is an outside author on the `community` platform. The
 * stream bridge knows which of them is this install's owner, and VOUCHES for each owner post it
 * imports ({@link vouchOwnerSpaceEntry}). In a space's local copy EVERYTHING else that is not
 * from this machine is a teammate's: an author on any platform, and one with no record at all,
 * so a post the bridge never saw (one cached before a restart, say) is held to the teammate rules
 * rather than given the owner's. A wrong answer the strict way costs one quiet turn; the other
 * way it hands a teammate the owner's power.
 *
 * **Why keying the vouch by local entry id is safe.** The id is minted HERE, when the post is
 * imported into one owner's copy of one space, never taken from the space. Each pairing with a
 * space mints a fresh `communityRef`, so its copy, and every entry in it, is new: a vouch cannot
 * outlive the pairing it was made under, cross to another owner's copy, or be named by a space
 * that wants one.
 *
 * In memory and bounded, like `turn-levels.ts`, and for the same reason: forgetting fails closed.
 *
 * @module server/services/rooms/limits/space-teammates
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';
import { entryLevelOf } from '../../core/turn-power/turn-levels.js';

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
 * as the owner. In a space's local copy that is every entry not from this machine, an
 * unresolvable author included; anywhere else, only a space member's (a person here, an agent
 * here, or a bridged chat is never a teammate).
 *
 * @param authors - The registry holding the stored author records.
 * @param entry - An entry a turn answers.
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 */
export function isTeammateEntry(
  authors: AuthorRegistry,
  entry: Pick<RoomEntry, 'id' | 'authorId'>,
  inSpaceRoom = false
): boolean {
  if (vouched.has(entry.id)) return false;
  const naturalKey = authors.getMany([entry.authorId]).get(entry.authorId)?.naturalKey;
  // Outside a space's copy an author with no record is already held to a stranger's ceiling
  // (`turn-ceiling.ts`); inside one it is a teammate, since nothing vouched for it.
  if (naturalKey === undefined) return inSpaceRoom;
  const origin = authorOrigin(naturalKey);
  if (origin === 'local') return false;
  return inSpaceRoom || origin.platform === SPACE_PLATFORM;
}

/**
 * The `teammate` spread a `RoomTurnRequest` takes: present when ANY message the turn answers is a
 * teammate's, because one turn answers them all at one level, or carries a teammate's mark on from
 * an earlier hop (DOR-3036): another agent's post written in a turn a teammate's words reached.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 */
export function teammateOf(
  authors: AuthorRegistry,
  entries: readonly Pick<RoomEntry, 'id' | 'authorId'>[],
  inSpaceRoom = false
): { teammate?: true } {
  return entries.some(
    (entry) =>
      isTeammateEntry(authors, entry, inSpaceRoom) || entryLevelOf(entry.id)?.teammate !== undefined
  )
    ? { teammate: true }
    : {};
}
