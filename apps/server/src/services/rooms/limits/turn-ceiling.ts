/**
 * What a room turn's triggering messages mean for it. A turn runs at its agent's set level, whoever
 * wrote what it answers (Dorian 2026-10-30, DOR-3440). One thing still bounds one: a post held to
 * the runtime's default because of who was calling (a Wi-Fi sign-in, DOR-3037). A teammate in a
 * shared space (DOR-2955) adds a record for the space's monthly limit, which lowers nothing.
 *
 * @module server/services/rooms/limits/turn-ceiling
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { entryHeldToDefault, entryMarksOf } from '../../core/turn-power/turn-levels.js';
import { ceilingCarrying } from '../../core/turn-power/turn-marks.js';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';
import { isTeammateEntry, isUnknownSpaceAgentPost } from './space-teammates.js';

/**
 * Whether the author of a triggering entry is somebody OUTSIDE this machine: a bridged Telegram or
 * Slack chat. A chat such a message starts seeds no stored mode, so it reads its agent's level.
 *
 * **An unresolvable author is external.** `authorOrigin` answers `'local'` for any key that does not
 * carry the external prefix, and an empty string is such a key, so no record at all is kept apart
 * from a stored key here.
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
 * The ceiling a turn this entry starts runs under, as the spread a `RoomTurnRequest` takes. A
 * teammate's only carries their mark (DOR-3036, `ceilingCarrying`). A post held to the default (a
 * person's from Wi-Fi, DOR-3037) is held to the runtime's default. Every other post has none.
 *
 * @param authors - The registry holding the stored author records.
 * @param entry - The entry that triggered the turn.
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 * @param roomId - The local room the turn answers in, which a teammate's mark names.
 */
export function ceilingForEntry(
  authors: AuthorRegistry,
  entry: Pick<RoomEntry, 'id' | 'authorId'> & { roomId?: string },
  inSpaceRoom = false,
  roomId = ''
): { permissionCeiling?: TurnPermissionCeiling } {
  const teammateRecord = (): TurnPermissionCeiling =>
    ceilingCarrying({ teammate: [{ roomId, authorId: entry.authorId }] })!;
  if (isTeammateEntry(authors, entry, inSpaceRoom)) return { permissionCeiling: teammateRecord() };
  if (entryHeldToDefault(entry.id, entry.roomId ?? (roomId || undefined))) {
    return { permissionCeiling: 'runtime-default' };
  }
  if (isUnknownSpaceAgentPost(authors, entry, inSpaceRoom, roomId || undefined)) {
    return { permissionCeiling: teammateRecord() };
  }
  const marks = entryMarksOf(entry.id, roomId || undefined);
  if (marks?.teammate !== undefined) return { permissionCeiling: ceilingCarrying(marks)! };
  return {};
}

/**
 * The ceiling a turn answering several messages runs under: every author's bound holds at once (a
 * list ceiling, resolved by the runtime to the strictest). Empty when no author is bounded.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 * @param roomId - The local room the turn answers in, which a teammate's mark names.
 */
export function ceilingForEntries(
  authors: AuthorRegistry,
  entries: readonly (Pick<RoomEntry, 'id' | 'authorId'> & { roomId?: string })[],
  inSpaceRoom = false,
  roomId = ''
): { permissionCeiling?: TurnPermissionCeiling } {
  const bounds = entries.flatMap((entry): TurnPermissionBound[] => {
    const one = ceilingForEntry(authors, entry, inSpaceRoom, roomId).permissionCeiling;
    if (one === undefined) return [];
    return Array.isArray(one) ? [...one] : [one as TurnPermissionBound];
  });
  if (bounds.length === 0) return {};
  return { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds };
}

/**
 * Whether any message a turn answers was written by anyone but a person on this machine: a stranger,
 * a teammate, another agent, or a person's line a mini app posted. Not about level: it keeps the
 * runtime from running those words as a command or expanding a file reference in them.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 * @param roomId - The room, to read a post's kept marks.
 */
export function answersUntrustedText(
  authors: AuthorRegistry,
  entries: readonly Pick<RoomEntry, 'id' | 'authorId'>[],
  roomId?: string
): boolean {
  return entries.some((entry) => {
    if (isEntryAuthorExternal(authors, entry.authorId)) return true;
    const kind = authors.getMany([entry.authorId]).get(entry.authorId)?.kind;
    if (kind === 'agent') return true;
    if (kind !== 'human') return false;
    return (
      entryHeldToDefault(entry.id, roomId) || entryMarksOf(entry.id, roomId)?.outsider === true
    );
  });
}
