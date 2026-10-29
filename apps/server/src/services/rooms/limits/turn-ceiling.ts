/**
 * The permission ceiling a room turn runs under, read from who wrote the
 * messages it answers (spec `trusted-by-default-flip` §4, DOR-1917).
 *
 * @module server/services/rooms/limits/turn-ceiling
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import {
  entryHeldToDefault,
  entryLevelOf,
  entryMarksOf,
} from '../../core/turn-power/turn-levels.js';
import {
  ceilingCarrying,
  hasMarks,
  marksOfLevel,
  mergeMarks,
  NO_MARKS,
} from '../../core/turn-power/turn-marks.js';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';
import { isTeammateEntry, isUnknownSpaceAgentPost } from './space-teammates.js';
import type { OwnCircle } from './own-circle.js';

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
 * receiving runtime's default. A teammate's (a space member who is not the
 * owner, DOR-2955) is held to that AND to read access: both bounds hold at once,
 * so the turn still counts as a stranger's everywhere `'runtime-default'` is
 * read for that. The read-access bound carries the teammate's mark (DOR-3036):
 * the space room they wrote in and who they are, so everything the turn sends
 * on carries it too. Another agent's post is held to the level its
 * turn ran at when it wrote the post; when that was not kept (a restart, a post
 * with no session), to the runtime's default, because the alternative is to
 * hand out the receiving conversation's level on the strength of a missing
 * record. A post held to the default (a person's from Wi-Fi, DOR-3037) is held
 * to the runtime's default whoever wrote it. A person on this machine and the
 * room's own voice are not bounded, except a person's post a mini app sent,
 * which is held to the runtime's default.
 *
 * @param authors - The registry holding the stored author records.
 * @param entry - The entry that triggered the turn.
 * In the owner's own circle (DOR-3107, `own-circle.ts`), an agent's post KNOWN
 * to carry no mark hands on no ceiling but the cap a person set on its poster:
 * marks, not levels. Without the circle, or for a post nobody kept marks for,
 * the rules above hold.
 *
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 * @param roomId - The local room the turn answers in, which a teammate's mark names.
 * @param circle - Whether this turn is in the owner's own circle, and posters' caps.
 */
export function ceilingForEntry(
  authors: AuthorRegistry,
  entry: Pick<RoomEntry, 'id' | 'authorId'> & { roomId?: string },
  inSpaceRoom = false,
  roomId = '',
  circle?: OwnCircle
): { permissionCeiling?: TurnPermissionCeiling } {
  if (isTeammateEntry(authors, entry, inSpaceRoom)) {
    const origin = { roomId, authorId: entry.authorId };
    return { permissionCeiling: ['runtime-default', { ...READ_ONLY_LEVEL, teammate: [origin] }] };
  }
  if (
    entryHeldToDefault(entry.id, entry.roomId ?? (roomId || undefined)) ||
    isEntryAuthorExternal(authors, entry.authorId)
  ) {
    return { permissionCeiling: 'runtime-default' };
  }
  const kind = authors.getMany([entry.authorId]).get(entry.authorId)?.kind;
  // A person's post that a mini app sent for them (DOR-3017) carries the
  // outsider mark: the mini app's page can post without a click, and may be
  // showing text it read from outside, so an agent it wakes runs at the
  // runtime's default rather than at the person's own level. Read through the
  // post's row too, so the cap survives a restart.
  if (
    kind === 'human' &&
    entryMarksOf(entry.id, entry.roomId ?? (roomId || undefined))?.outsider === true
  ) {
    return { permissionCeiling: 'runtime-default' };
  }
  if (kind !== 'agent') return {};
  // In the owner's own circle only a MARKED post caps (DOR-3107; trust first,
  // Dorian 2026-10-19): one known unmarked, or one whose marks nobody kept (a
  // restart, an old row), hands on just the cap a person set on its poster. A
  // post from a caller DorkOS could not verify is kept marked at write time.
  if (circle?.ownCircle) {
    const marks = entryMarksOf(entry.id, roomId || undefined);
    if (!marks || !hasMarks(marks)) {
      const cap = circle.posterCap?.(entry.authorId);
      return cap !== undefined ? { permissionCeiling: cap } : {};
    }
  }
  const level = entryLevelOf(entry.id);
  if (level !== undefined) {
    // A marked post caps what it wakes on top of its poster's level (DOR-3141): the level
    // alone is the poster's own power, Full for an own agent, so the mark has to ride as
    // a bound of its own, as it does after a restart when only the row's marks are left.
    const marks = mergeMarks(
      marksOfLevel(level),
      entryMarksOf(entry.id, roomId || undefined) ?? NO_MARKS
    );
    const carried = ceilingCarrying(marks);
    if (carried === undefined) return { permissionCeiling: level };
    return { permissionCeiling: [level, ...(Array.isArray(carried) ? carried : [carried])] };
  }
  // The level is gone (a restart) or was never kept: the post's row still says what it carried.
  if (isUnknownSpaceAgentPost(authors, entry, inSpaceRoom, roomId || undefined)) {
    const origin = { roomId, authorId: entry.authorId };
    return { permissionCeiling: ['runtime-default', { ...READ_ONLY_LEVEL, teammate: [origin] }] };
  }
  const kept = entryMarksOf(entry.id, roomId || undefined);
  return { permissionCeiling: (kept && ceilingCarrying(kept)) || 'runtime-default' };
}

/**
 * The ceiling a turn answering several messages runs under: every author's
 * bound holds at once (a list ceiling, resolved by the runtime to the
 * strictest). Empty when no author is bounded.
 *
 * @param authors - The registry holding the stored author records.
 * @param entries - Every message the turn answers.
 * @param inSpaceRoom - Whether the turn is in a local copy of a space's channel.
 * @param roomId - The local room the turn answers in, which a teammate's mark names.
 * @param circle - Whether this turn is in the owner's own circle, and posters' caps.
 */
export function ceilingForEntries(
  authors: AuthorRegistry,
  entries: readonly (Pick<RoomEntry, 'id' | 'authorId'> & { roomId?: string })[],
  inSpaceRoom = false,
  roomId = '',
  circle?: OwnCircle
): { permissionCeiling?: TurnPermissionCeiling } {
  const bounds = entries.flatMap((entry): TurnPermissionBound[] => {
    const one = ceilingForEntry(authors, entry, inSpaceRoom, roomId, circle).permissionCeiling;
    if (one === undefined) return [];
    return Array.isArray(one) ? [...one] : [one as TurnPermissionBound];
  });
  if (bounds.length === 0) return {};
  return { permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds };
}

/**
 * Whether a room turn is SHOWN words from outside the owner's circle that it
 * does not answer, as the `roomTurn` spread that says so (spec
 * `trusted-by-default-flip` §4.7): a stranger's line in the recent window, the
 * gathered burst or the channel tail, or another agent's post that was itself
 * written in a turn that read one, or a person's line written from Wi-Fi
 * (DOR-3037).
 *
 * **Fenced, not ceilinged — that is the decision this makes.** The turn
 * answers somebody else, usually the person who owns the room, and holding it
 * to asking because a stranger once spoke in the same shared channel would
 * take the owner's own power away in every room a space member ever posted
 * in. The lines are already rendered inside the untrusted fence, the same as
 * a web page the agent reads. What the mark adds is that the turn is recorded
 * as one that read an outsider's words, so a note it saves says so and a turn
 * its post or chat message starts carries the same mark on.
 *
 * An agent's post that kept no level (a Codex or OpenCode post, a reply
 * written as turn text, any post from before a restart) is NOT counted here,
 * unlike one the turn answers, which the runtime-default bound marks. Counting
 * it would hold the owner's own memory edits in every room after a restart or
 * beside a Codex agent, for a line nobody can show came from outside. A
 * person's line from this machine and the room's own notices never count,
 * except a person's line a mini app posted for them, which keeps the outsider
 * mark on its row (DOR-3017).
 *
 * @param context - The room context the turn is about to be shown.
 * @param roomId - The room, to read a post's kept marks once its level is gone (DOR-3036).
 */
export function outsiderInViewOf(
  context: Pick<RoomContextData, 'pending' | 'gathered' | 'channelTail'>,
  roomId?: string
): { outsiderInView?: true } {
  const shown = [...context.pending, ...(context.gathered ?? []), ...(context.channelTail ?? [])];
  const outsider = shown.some((entry) => {
    if (entry.authorOrigin === 'external' || entryHeldToDefault(entry.id, roomId)) return true;
    if (entry.kind !== 'post') return false;
    // A person's own line carries no marks and never counts; one a mini app
    // posted for them carries the outsider mark (DOR-3017) and does.
    return entryMarksOf(entry.id, roomId)?.outsider === true;
  });
  return outsider ? { outsiderInView: true } : {};
}
