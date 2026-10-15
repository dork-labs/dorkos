import type { RoomEntry, SkippedTrigger } from '@dorkos/shared/room-schemas';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { entryLevelOf } from '../../core/turn-power/turn-levels.js';
import { authorOrigin, type AuthorRegistry } from '../author-registry.js';
import type { RoomDispatchSummary } from './room-trigger-contract.js';

/**
 * The answer for a post that asked nothing of anybody — a notice, which never
 * addresses a member.
 *
 * A fresh object each call rather than one shared constant: the arrays reach a
 * response body, and a caller that appended to a shared empty one would be
 * making a claim about every other message this process ever wrote.
 *
 * @returns An empty summary — triggered nobody, skipped nobody.
 */
export function nothingDispatched(): RoomDispatchSummary {
  return { triggered: [], skipped: [] };
}

/**
 * Append the agents that could not be reached at all to the guard's own
 * refusals, one row per agent.
 *
 * **The two sets are disjoint by construction, not by filtering**, and that is
 * worth stating because it is easy to add a branch that breaks it. An author can
 * genuinely arrive from both directions — named by the message AND selected as a
 * target — and {@link RoomTriggerDispatcher.selectCandidates} resolves it at the
 * only place it can: a member already in `gone` is passed over by the guard's
 * refusal branch entirely, so it is reported once, as `gone`, and the room writes
 * it one notice. A de-duplication pass here would be a second answer to a
 * question already settled, and one nothing could ever exercise.
 *
 * @param refused - What the cascade guard stopped, in the order it stopped it.
 * @param gone - Every author whose agent its directory no longer holds.
 * @returns One row per author, guard refusals first.
 */
export function withGone(
  refused: readonly SkippedTrigger[],
  gone: ReadonlySet<string>
): SkippedTrigger[] {
  return [
    ...refused,
    ...[...gone].map((authorId): SkippedTrigger => ({ authorId, reason: 'gone' })),
  ];
}

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
