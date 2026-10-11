/**
 * The permission ceiling a room turn runs under, read from who wrote the
 * messages it answers (spec `trusted-by-default-flip` §4, DOR-1917).
 *
 * @module server/services/rooms/limits/turn-ceiling
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { entryLevelOf } from '../../core/turn-power/turn-levels.js';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';

/**
 * Whether the author of a triggering entry is somebody OUTSIDE this machine.
 *
 * The one decision it feeds is `RoomTurnRequest.externalAuthor`: a room turn
 * follows the operator's configured power level (DOR-1917), and a message from a
 * bridged Telegram or Slack chat must not be what starts a session at it.
 *
 * **An unresolvable author is external.** `authorOrigin` answers `'local'` for
 * any key that does not carry the external prefix, and an empty string is such a
 * key — so a failed lookup folded into a `?? ''` default would quietly grant the
 * operator's power level on the strength of a missing row. The two cases are kept
 * apart here: no record at all is the conservative answer, a stored key is the
 * real derivation. Losing the power level for one turn costs a prompt.
 *
 * @param authors - The registry holding the stored author records.
 * @param authorId - The author of the entry that triggered this turn.
 */
export function isEntryAuthorExternal(authors: AuthorRegistry, authorId: string): boolean {
  const naturalKey = authors.getMany([authorId]).get(authorId)?.naturalKey;
  if (naturalKey === undefined) return true;
  return authorOrigin(naturalKey) !== 'local';
}

/**
 * The ceiling a turn this entry starts runs under, as the spread a
 * `RoomTurnRequest` takes (spec `trusted-by-default-flip` §4).
 *
 * A stranger's message, or one whose author cannot be resolved, is held to the
 * receiving runtime's default. Another agent's post is held to the level its
 * turn ran at when it wrote the post; when that was not kept (a restart, a post
 * with no session), to the runtime's default, because the alternative is to
 * hand out the receiving conversation's level on the strength of a missing
 * record. A person on this machine and the room's own voice are not bounded.
 *
 * @param authors - The registry holding the stored author records.
 * @param entry - The entry that triggered the turn.
 */
export function ceilingForEntry(
  authors: AuthorRegistry,
  entry: Pick<RoomEntry, 'id' | 'authorId'>
): { permissionCeiling?: TurnPermissionCeiling } {
  if (isEntryAuthorExternal(authors, entry.authorId)) {
    return { permissionCeiling: 'runtime-default' };
  }
  const kind = authors.getMany([entry.authorId]).get(entry.authorId)?.kind;
  if (kind !== 'agent') return {};
  return { permissionCeiling: entryLevelOf(entry.id) ?? 'runtime-default' };
}

/**
 * The ceiling a turn answering several messages runs under: every author's
 * bound holds at once (a list ceiling, resolved by the runtime to the
 * strictest). Empty when no author is bounded.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 */
export function ceilingForEntries(
  authors: AuthorRegistry,
  entries: readonly Pick<RoomEntry, 'id' | 'authorId'>[]
): { permissionCeiling?: TurnPermissionCeiling } {
  const bounds = entries.flatMap((entry) => {
    const one = ceilingForEntry(authors, entry).permissionCeiling;
    return one === undefined ? [] : [one as TurnPermissionBound];
  });
  if (bounds.length === 0) return {};
  return { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds };
}
