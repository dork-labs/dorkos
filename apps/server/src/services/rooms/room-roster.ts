/**
 * The membership half of the room domain: who is in a room, how they behave in
 * it, and where they have read up to.
 *
 * Split from `room-service.ts` on a real boundary rather than a line count.
 * Everything here answers "who is in this room and how do they behave"; the
 * service answers "what does the room do". The roster is also where the two
 * projections a reader needs live — a membership with its author resolved, and
 * the `@name` candidate list mention resolution matches against.
 *
 * @module server/services/rooms/room-roster
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { AuthorRef, Room, RoomMember, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { advertisedHandles, mentionCandidatesFrom } from './author-handles.js';
import { toAuthorRef, type AuthorRecord, type AuthorRegistry } from './author-registry.js';
import type { MentionCandidate } from './mentions.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';

/** The membership seed a channel gets, per spec §2. */
const CHANNEL_RESPONSE_MODE: ResponseMode = 'mention-only';

/**
 * What a non-agent membership stores. The column is NOT NULL and the value is
 * never read for a human or the system, so this is the enum default, not a
 * claim about behavior.
 */
const INERT_RESPONSE_MODE: ResponseMode = 'always';

/** How to name a member: by an existing author, or by an agent's directory. */
export interface AddMemberInput {
  authorId?: string;
  /** An agent's directory; its author row is minted on first use. */
  agentPath?: string;
  /** Explicit override; omit to seed from the room kind. */
  responseMode?: ResponseMode;
}

/** Roster reads and writes over one room's memberships. */
export class RoomRoster {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly agents: RoomAgentLookup;

  constructor(deps: { store: RoomStore; authors: AuthorRegistry; agents: RoomAgentLookup }) {
    this.store = deps.store;
    this.authors = deps.authors;
    this.agents = deps.agents;
  }

  /**
   * Add a member, seeding `responseMode` from the room kind unless the caller
   * named one.
   *
   * @param room - The room being joined.
   * @param input - Who to add, and optionally how they should behave.
   * @returns The stored membership with its author resolved.
   */
  add(room: Room, input: AddMemberInput): RoomRosterEntry {
    const author = this.resolve(input);
    const member = this.store.addMember({
      roomId: room.id,
      authorId: author.id,
      responseMode: input.responseMode ?? this.seedResponseMode(room, author),
      joinedAt: new Date().toISOString(),
    });
    return { ...member, author: toAuthorRef(author) };
  }

  /**
   * Change one membership's per-room response mode.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param responseMode - The new override.
   */
  setResponseMode(roomId: string, authorId: string, responseMode: ResponseMode): RoomRosterEntry {
    const member = this.store.setResponseMode(roomId, authorId, responseMode);
    if (!member) throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    return this.withAuthor(member);
  }

  /**
   * Advance a member's read cursor. Monotonic — a lower value is ignored, so a
   * stale client cannot un-read a room for a second client.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq they have read up to.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember {
    const member = this.store.setReadCursor(roomId, authorId, lastReadSeq);
    if (!member) throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    return member;
  }

  /**
   * Remove a member, dropping its per-room session binding with it.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   */
  remove(roomId: string, authorId: string): void {
    if (!this.store.removeMember(roomId, authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
  }

  /**
   * A room's roster with every author resolved — one query for the memberships
   * and one for the authors, not one per member.
   *
   * This is the projection a mention picker reads, so it is the one that also
   * carries each member's `mentionHandle`. That costs one mesh lookup per agent
   * member, which is why it is not done on the bulk room-list path
   * ({@link RoomRoster.authorsIn}) where nothing addresses anybody.
   *
   * @param roomId - The room.
   */
  list(roomId: string): RoomRosterEntry[] {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    // Ownership comes from `author-handles.ts`, over the SAME candidate sequence
    // `mentionCandidates` hands `resolveMentions` — so a handle is advertised to
    // a member only when that member is the one it would actually reach, and the
    // roster an agent reads cannot disagree with the roster a picker reads.
    const handles = advertisedHandles(mentionCandidatesFrom(members, authors, this.agents));
    return members.map((member) => {
      const author = authors.get(member.authorId);
      if (!author) return { ...member, author: unknownAuthor(member.authorId) };
      return { ...member, author: toAuthorRef(author, handles.get(member.authorId)) };
    });
  }

  /**
   * The authors in each of several rooms, resolved — two queries for the whole
   * set, not two per room. This is what puts a direct message's counterpart on
   * the room list without the sidebar fetching every DM one at a time.
   *
   * Every id asked for comes back with an entry, so an empty array means "that
   * room has nobody in it" and a missing key means "you did not ask about it".
   *
   * @param roomIds - The rooms to read.
   */
  authorsIn(roomIds: readonly string[]): Map<string, AuthorRef[]> {
    const byRoom = new Map<string, AuthorRef[]>(roomIds.map((id) => [id, []]));
    if (roomIds.length === 0) return byRoom;
    const members = this.store.listMembersForRooms(roomIds);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    for (const member of members) {
      const author = authors.get(member.authorId);
      byRoom
        .get(member.roomId)
        ?.push(author ? toAuthorRef(author) : unknownAuthor(member.authorId));
    }
    return byRoom;
  }

  /**
   * The names each member answers to for `@` resolution: an agent's handle
   * first, then whatever it renders as.
   *
   * @param roomId - The room.
   */
  mentionCandidates(roomId: string): MentionCandidate[] {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    return mentionCandidatesFrom(members, authors, this.agents);
  }

  /**
   * The `responseMode` a membership is seeded with, per spec §2: the parent's
   * value in a thread, `mention-only` in a channel, the agent's manifest default
   * in a DM. Written explicitly at join time, so nothing has to re-derive it
   * later and changing the manifest never rewrites a room somebody already
   * configured.
   *
   * The field describes when an AGENT answers without being addressed. Humans
   * and the system are never auto-triggered — addressing filters to agent
   * members — so for them it is inert, and they get the enum's own default
   * rather than a restriction nothing enforces and nobody chose.
   *
   * @param room - The room being joined.
   * @param author - The author joining.
   */
  seedResponseMode(room: Room, author: AuthorRecord): ResponseMode {
    if (author.kind !== 'agent') return INERT_RESPONSE_MODE;
    if (room.kind === 'thread' && room.parentId) {
      const inherited = this.store.getMember(room.parentId, author.id);
      if (inherited) return inherited.responseMode;
    }
    if (room.kind === 'channel') return CHANNEL_RESPONSE_MODE;
    return this.agents.byPath(author.naturalKey)?.responseMode ?? 'always';
  }

  /**
   * Resolve an existing author id, throwing the typed not-found rather than
   * returning null. Used where a caller has already been validated.
   *
   * @param authorId - The author id.
   */
  requireAuthor(authorId: string): AuthorRecord {
    const author = this.authors.getById(authorId);
    if (!author) throw new RoomError('MEMBER_NOT_FOUND', 'No such author');
    return author;
  }

  /**
   * Resolve whichever of `authorId` / `agentPath` the caller supplied, minting
   * the author row for an agent that has never been in a room.
   *
   * Public because room creation needs the SAME resolution the join path uses,
   * before it writes anything: a DM is created and joined in one transaction,
   * so an unregistered agent path has to fail while the room does not exist yet.
   *
   * @param input - Who to resolve, by author id or by agent directory.
   */
  resolve(input: AddMemberInput): AuthorRecord {
    if (input.agentPath) {
      const agent = this.agents.byPath(input.agentPath);
      if (!agent) throw new RoomError('AGENT_NOT_FOUND', 'No agent registered at that path');
      return this.authors.resolveAgent(input.agentPath, agent.displayName, {
        emoji: agent.emoji,
        color: agent.color,
      });
    }
    if (input.authorId) return this.requireAuthor(input.authorId);
    throw new RoomError('MEMBER_NOT_FOUND', 'No such author');
  }

  /** Attach one resolved author to one membership. */
  private withAuthor(member: RoomMember): RoomRosterEntry {
    const author = this.authors.getById(member.authorId);
    return { ...member, author: author ? toAuthorRef(author) : unknownAuthor(member.authorId) };
  }
}

/**
 * Placeholder for a membership whose author row has vanished. Rendering
 * "Unknown" is honest; dropping the row would silently shrink a roster.
 */
function unknownAuthor(id: string): AuthorRef {
  return { id, kind: 'system', displayName: 'Unknown' };
}
