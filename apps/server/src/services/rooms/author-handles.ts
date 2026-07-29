/**
 * What string reaches an author in one room — the single derivation of it.
 *
 * Three surfaces have to agree on the name that addresses a member: the mention
 * picker (`RoomRoster.list`), the roster an agent is handed
 * (`room-context.ts` → `runtimes/shared/room-context-block.ts`), and the
 * resolver every posted message runs through (`resolveMentions`, from
 * `RoomService.post`). They agree because all three read THIS module, over the
 * same candidate sequence in the same order.
 *
 * **A second derivation is the bug, not a duplication.** `room-context.ts` had
 * one: it handed the model `agents.byPath(naturalKey)?.name` unfiltered, so an
 * agent in a room with `Art Blocks Analytics` was told that was its address —
 * a string `MENTION_PATTERN` truncates at the first space, so the message
 * reached nobody — while the picker, reading {@link advertisedHandle}, correctly
 * refused to offer that member at all. Two answers to "who owns this name" can
 * only ever drift into one of them addressing somebody else, and an agent handed
 * a name it cannot be reached by has no way to notice the way a person would
 * (`meta/agent-etiquette.md` E1).
 *
 * Pure over what the caller has already read: no store, no query, no clock.
 *
 * @module server/services/rooms/author-handles
 */
import type { RoomMember } from '@dorkos/shared/room-schemas';
import type { AuthorRecord } from './author-registry.js';
import { advertisedHandle, claimNames, type MentionCandidate } from './mentions.js';
import type { RoomAgentLookup } from './room-errors.js';

/**
 * Every name an author answers to after an `@`, most preferred first: an agent's
 * handle, then whatever it renders as.
 *
 * The single definition behind both halves of the contract — what
 * `RoomRoster.mentionCandidates` resolves at write time, and what
 * {@link advertisedHandles} may advertise. Two derivations of "the name this
 * author answers to" is how a picker starts offering a handle the resolver does
 * not accept.
 *
 * @param author - The stored author.
 * @param agents - The lookup that resolves an agent's handle from its directory.
 */
export function mentionNamesFor(author: AuthorRecord, agents: RoomAgentLookup): string[] {
  const handle = author.kind === 'agent' ? agents.byPath(author.naturalKey)?.name : null;
  return handle ? [handle, author.displayName] : [author.displayName];
}

/**
 * Project already-read memberships onto the mention-candidate sequence.
 *
 * Takes what the caller has already fetched rather than re-querying, so a caller
 * that has the roster in hand pays nothing to ask who owns what. Order is the
 * caller's — and it matters, because it decides which member wins a contested
 * name. Every caller passes `RoomStore.listMembers` order, which is the order
 * `resolveMentions` sees at write time.
 *
 * @param members - The room's memberships, in store order.
 * @param authors - The resolved authors, keyed by id. A member whose author row
 *   has vanished is skipped: it answers to no name.
 * @param agents - The lookup that resolves an agent's handle from its directory.
 */
export function mentionCandidatesFrom(
  members: readonly RoomMember[],
  authors: ReadonlyMap<string, AuthorRecord>,
  agents: RoomAgentLookup
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  for (const member of members) {
    const author = authors.get(member.authorId);
    if (!author) continue;
    candidates.push({ authorId: author.id, names: mentionNamesFor(author, agents) });
  }
  return candidates;
}

/**
 * The handle each member may be shown: the first name it can be typed by **and**
 * actually owns, decided over the whole roster at once.
 *
 * Computed for the sequence rather than per member, because ownership is a
 * property of the roster and not of the row. Deriving it one member at a time
 * cannot see a name an earlier member claimed but never advertised, and so
 * silently hands out a handle that addresses somebody else.
 *
 * @param candidates - The whole roster, in the order that decides ties.
 * @returns Author id to handle, omitting every member no string reaches. A
 *   missing key is the honest answer, not a lookup that failed.
 */
export function advertisedHandles(candidates: readonly MentionCandidate[]): Map<string, string> {
  const claims = claimNames(candidates);
  const handles = new Map<string, string>();
  for (const candidate of candidates) {
    const handle = advertisedHandle(candidate, claims);
    if (handle) handles.set(candidate.authorId, handle);
  }
  return handles;
}
