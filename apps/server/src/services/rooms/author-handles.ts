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
 * Whether an agent author still speaks for the directory it names.
 *
 * **Two conditions, and the second is not implied by the first.**
 *
 * 1. The directory resolves to a registered agent. When it does not, the author
 *    is a GHOST — a row the reconciler's orphan sweep or a genuine relocation
 *    left behind. Note what this is not: an agent with `status: 'unreachable'`
 *    has a row, resolves, and keeps its handle. A laptop that closed its lid
 *    must not lose its name mid-conversation.
 * 2. The author's generation stamp, when it has one, names that same agent.
 *    "An active row implies a matching stamp" is FALSE at this seam: the roster
 *    path reaches it through `AuthorRegistry.getMany`, not `resolve`, so no
 *    retirement decision has run. Agent B registered at agent A's old directory
 *    but not yet posting leaves A's row active with A's stamp while the lookup
 *    returns B — and without this comparison A's author would claim B's handle.
 *
 * Non-agent authors are always live: there is no directory behind a human or the
 * system voice for anything to become vacant.
 *
 * @param author - The stored author.
 * @param agents - The lookup that resolves an agent from its directory.
 */
export function isLiveAuthor(author: AuthorRecord, agents: RoomAgentLookup): boolean {
  if (author.kind !== 'agent') return true;
  const occupant = agents.byPath(author.naturalKey);
  if (!occupant) return false;
  return author.mintedForManifestId === null || author.mintedForManifestId === occupant.id;
}

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
 * **An agent author that is not live answers to NOTHING** ({@link isLiveAuthor}).
 * The old fallback to `[displayName]` is exactly how a ghost claimed a name:
 * `claimNames` is first-claimant-wins over the roster, so a ghost ahead of a
 * live agent with the same display name took the name and the live agent was
 * unreachable by mention — verified by execution, not reasoning. Returning no
 * names releases the claim at its source, which is also what keeps
 * {@link advertisedHandles} from offering it: a candidate with no names owns
 * nothing to advertise.
 *
 * @param author - The stored author.
 * @param agents - The lookup that resolves an agent's handle from its directory.
 */
export function mentionNamesFor(author: AuthorRecord, agents: RoomAgentLookup): string[] {
  if (!isLiveAuthor(author, agents)) return [];
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
 * A ghost member stays in the sequence carrying an EMPTY name list rather than
 * being dropped from it. The sequence mirrors the roster, and a candidate with
 * no names claims nothing and is offered nothing — so the exclusion lives in one
 * place ({@link mentionNamesFor}) instead of being re-derived here.
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
