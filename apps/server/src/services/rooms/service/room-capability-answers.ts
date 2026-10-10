/**
 * How a room verb answers: a typed refusal becomes the MCP `isError` payload,
 * and a roster change reports what happened to each member it named.
 *
 * @module server/services/rooms/service/room-capability-answers
 */
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { CapabilityToolError } from '../../core/capabilities/index.js';
import type { AuthorRecord } from '../author-registry.js';
import { RoomError, roomRefusalFor } from '../room-errors.js';
import { normalizeMemberHandle, type RoomService } from '../room-service.js';

/**
 * Run a room verb, turning its typed refusal into the MCP `isError` payload
 * rather than a stack trace.
 *
 * A {@link RoomError} is the room saying no for a reason the caller can act on —
 * "you are not in that room", "that is a direct message", "you have used up your
 * reactions". The code travels with the message so an agent can branch on it
 * without parsing prose. Anything else propagates: an unexpected throw is a bug,
 * and swallowing it into a tidy payload is how a bug becomes a behaviour.
 *
 * **What the refusal says depends on who asked** ({@link roomRefusalFor},
 * DOR-2457): a room whose git settings name a program is explained in full,
 * path and command, only to the install's owner. `ownerAsking` is read when a
 * refusal happens, after the verb had its chance to resolve the caller, and
 * defaults to "no" — an agent, another person, and a caller nobody resolved
 * are all told only that the files are paused.
 *
 * @param body - The verb.
 * @param ownerAsking - Whether the resolved caller is the install's owner.
 * @returns Whatever the verb returned.
 * @throws {CapabilityToolError} Carrying `{ error, code }` for a typed refusal.
 */
export function answering<T>(body: () => T, ownerAsking: () => boolean = () => false): T {
  try {
    return body();
  } catch (err) {
    if (err instanceof RoomError) {
      throw new CapabilityToolError(roomRefusalFor(err, ownerAsking));
    }
    throw err;
  }
}

/**
 * {@link answering} for a verb that returns a promise.
 *
 * Its own function rather than a widened signature, because the sync one CANNOT
 * do this job: a `try` around a call that returns a rejected promise catches
 * nothing, so a merge refusal would have reached the model as an unhandled
 * rejection with a stack trace where its typed code should have been. Every
 * refusal in the room-repo contract is asynchronous, so all of them would have
 * been affected.
 *
 * @param body - The verb.
 * @param ownerAsking - As {@link answering}'s.
 * @returns Whatever the verb resolved to.
 * @throws {CapabilityToolError} Carrying `{ error, code }` for a typed refusal.
 */
export async function answeringAsync<T>(
  body: () => Promise<T>,
  ownerAsking: () => boolean = () => false
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof RoomError) {
      throw new CapabilityToolError(roomRefusalFor(err, ownerAsking));
    }
    throw err;
  }
}

/**
 * Turn the `@handles` a caller typed into author ids, keeping the ones that
 * name nobody so the caller can be told which (DOR-1611).
 *
 * Handles are the only member name an agent holds — `get_room` hands out a
 * roster of them and `find_room` filters on them — so every management verb
 * takes them and nothing else. Resolution itself lives on the service
 * ({@link RoomService.findAuthorByHandle}), which is what keeps this seam from
 * growing a second opinion about what a handle matches.
 *
 * @param rooms - The rooms service.
 * @param handles - The handles as typed, with or without their `@`.
 * @returns The author ids that resolved, and the handles that named nobody.
 */
export function resolveHandles(
  rooms: RoomService,
  handles: readonly string[]
): { resolved: AuthorRecord[]; unknown: string[] } {
  const resolved = new Map<string, AuthorRecord>();
  const unknown: string[] = [];
  for (const token of handles) {
    const author = rooms.findAuthorByHandle(token);
    // Keyed by the author rather than by the string, for the reason
    // {@link applyPerMember} gives: one member written two ways is one member,
    // and `@bo` beside Bo's author id is now one of the ways.
    if (author) resolved.set(author.id, author);
    else if (
      !unknown.some((seen) => normalizeMemberHandle(seen) === normalizeMemberHandle(token))
    ) {
      unknown.push(token);
    }
  }
  return { resolved: [...resolved.values()], unknown };
}

/**
 * Apply one roster change per member and report what happened to each
 * (spec `rooms-management-tools` §D8, decision D19).
 *
 * **Not atomic, and the output shape is how that stays honest.** A refusal
 * partway down the list leaves the members before it applied, which is the right
 * behaviour — adding four colleagues should not be undone because the fifth
 * handle was a typo — but it is only safe if the caller can SEE it. A bare
 * boolean would make a partial application something a model had to infer from
 * an error, so each member comes back under `applied` or under `refused` with
 * the code and the sentence that explains it.
 *
 * **The room is resolved once, before the loop.** A room the caller cannot see
 * is one refusal about the room, not N identical refusals about its members —
 * and `describeRoom` answers `ROOM_NOT_FOUND` for a room that is not there and
 * for one the caller is not in, so a room id is never a capability here either.
 *
 * @param rooms - The rooms service.
 * @param roomId - The room being changed.
 * @param callerAuthorId - Who is asking.
 * @param handles - The members to apply, by handle.
 * @param apply - The roster write to attempt for one resolved author.
 * @returns Per-member outcomes, in the order the caller listed them.
 */
export function applyPerMember(
  rooms: RoomService,
  roomId: string,
  callerAuthorId: string,
  handles: readonly string[],
  apply: (authorId: string) => void
): { applied: string[]; refused: { handle: string; code: string; message: string }[] } {
  // Throws if the caller cannot see the room, before anything is written.
  answering(() => rooms.describeRoom(roomId, callerAuthorId));

  const applied: string[] = [];
  const refused: { handle: string; code: string; message: string }[] = [];
  // **Deduplicated on the RESOLVED author, not on the string** (DOR-1611
  // review). `['bo', '@bo', ' BO ', '@@bo']` is one member written four ways —
  // the sigil is optional, the match is case-insensitive, and an id is now a
  // second spelling of the same person — and applying it four times reported
  // four successes for one change, which is the opposite of what the per-member
  // shape exists to make legible. Resolving first and keying on the id catches
  // every spelling, including the two that no string comparison could:
  // `@bo` beside Bo's author id, and a handle beside the id it belongs to.
  // Unresolvable tokens dedupe on their normalized form instead, so a typo
  // repeated is one refusal rather than several identical ones.
  const seenAuthors = new Set<string>();
  const seenMissing = new Set<string>();
  for (const token of handles) {
    const author = rooms.findAuthorByHandle(token);
    if (!author) {
      const key = normalizeMemberHandle(token);
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      refused.push({
        // Sanitized, like every other label this seam hands back: the token is
        // whatever the model typed, and it lands in text another model reads.
        handle: sanitizeIdentity(token) ?? 'that name',
        code: 'MEMBER_NOT_FOUND',
        message: `Nobody here answers to ${sanitizeIdentity(token) ?? 'that name'}.`,
      });
      continue;
    }
    if (seenAuthors.has(author.id)) continue;
    seenAuthors.add(author.id);
    const label = sanitizeIdentity(author.handle ?? author.displayName) ?? author.id;
    try {
      apply(author.id);
      applied.push(label);
    } catch (err) {
      if (err instanceof RoomError) {
        refused.push({ handle: label, code: err.code, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return { applied, refused };
}
