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
 * handle, then whatever it renders as — with the liveness question not asked.
 *
 * The single definition of "the name this author answers to", read TWICE by
 * {@link rosterMentionCandidates} and meaning the same thing both times: for a
 * live author it is what a name reaches, and for a ghost it is what a name
 * WOULD have reached. Deriving the second from anything but the first is how a
 * person's `@ana` comes to be recognised by one half of the room and not the
 * other.
 *
 * @param author - The stored author.
 * @param agents - The lookup that resolves an agent's handle from its directory.
 */
function namesAnsweredTo(author: AuthorRecord, agents: RoomAgentLookup): string[] {
  const handle = author.kind === 'agent' ? agents.byPath(author.naturalKey)?.name : null;
  return handle ? [handle, author.displayName] : [author.displayName];
}

/**
 * A room's roster split by whether a member can still be reached by name.
 *
 * Both halves come out of ONE walk of the roster, because they are two readings
 * of the same question and a second walk is how they would come to disagree.
 */
export interface RosterCandidates {
  /**
   * Who a name may actually reach, in roster order — the sequence
   * `resolveMentions` runs against and the only one a handle is advertised from.
   */
  live: MentionCandidate[];
  /**
   * Members a name WOULD have reached, if their author still spoke for its
   * directory. Nothing addresses them; they exist so that typing a ghost's name
   * is answered rather than swallowed.
   */
  unreachable: MentionCandidate[];
}

/**
 * Project already-read memberships onto the mention-candidate sequences.
 *
 * Takes what the caller has already fetched rather than re-querying, so a caller
 * that has the roster in hand pays nothing to ask who owns what. Order is the
 * caller's — and it matters, because it decides which member wins a contested
 * name. Every caller passes `RoomStore.listMembers` order, which is the order
 * `resolveMentions` sees at write time.
 *
 * **This is the seam that releases a ghost's claims, and it is the only one.**
 * `claimNames` is first-claimant-wins over `live`, so a ghost ahead of a live
 * agent with the same display name used to take the name and starve it —
 * verified by execution, not reasoning. A ghost therefore stays in `live`
 * carrying an EMPTY name list: it mirrors the roster, claims nothing, and is
 * offered nothing, so {@link advertisedHandles} needs no rule of its own.
 *
 * The SAME member appears in `unreachable` with the names it would have
 * answered to. Releasing a name must not make it a SILENT name: `@ana are you
 * there?` now addresses nobody, and a message that addresses nobody triggers
 * nobody and would leave the room quiet in answer to a direct question. This is
 * what lets the person who typed it be told why nobody came.
 *
 * @param members - The room's memberships, in store order.
 * @param authors - The resolved authors, keyed by id. A member whose author row
 *   has vanished is skipped: it answers to no name.
 * @param agents - The lookup that resolves an agent's handle from its directory.
 */
export function rosterMentionCandidates(
  members: readonly RoomMember[],
  authors: ReadonlyMap<string, AuthorRecord>,
  agents: RoomAgentLookup
): RosterCandidates {
  const live: MentionCandidate[] = [];
  const unreachable: MentionCandidate[] = [];
  for (const member of members) {
    const author = authors.get(member.authorId);
    if (!author) continue;
    const names = namesAnsweredTo(author, agents);
    if (isLiveAuthor(author, agents)) {
      live.push({ authorId: author.id, names });
      continue;
    }
    live.push({ authorId: author.id, names: [] });
    unreachable.push({ authorId: author.id, names });
  }
  return { live, unreachable };
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
