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
import { toAuthorRef, type AuthorRecord, type AuthorRegistry } from './author-registry.js';
import type { MentionCandidate } from './mentions.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';

/** The membership seed a channel gets, per spec §2. */
const CHANNEL_RESPONSE_MODE: ResponseMode = 'mention-only';

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
    const author = this.resolveTarget(input);
    const member = this.store.addMember({
      roomId: room.id,
      authorId: author.id,
      responseMode: input.responseMode ?? this.seedResponseMode(room, author),
      joinedAt: new Date().toISOString(),
    });
    return { ...member, author: toAuthorRef(author) };
  }

  /**
   * Copy a parent room's roster onto a new thread.
   *
   * Each membership inherits the PARENT's `responseMode` rather than re-seeding
   * from the room kind: an agent you asked to stay quiet in `#backend` should
   * not start answering everything because somebody opened a thread there.
   *
   * @param parentRoomId - The room to copy from.
   * @param threadRoomId - The thread to copy onto.
   */
  inherit(parentRoomId: string, threadRoomId: string): void {
    const joinedAt = new Date().toISOString();
    for (const member of this.store.listMembers(parentRoomId)) {
      this.store.addMember({
        roomId: threadRoomId,
        authorId: member.authorId,
        responseMode: member.responseMode,
        joinedAt,
      });
    }
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
   * @param roomId - The room.
   */
  list(roomId: string): RoomRosterEntry[] {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    return members.map((member) => {
      const author = authors.get(member.authorId);
      return { ...member, author: author ? toAuthorRef(author) : unknownAuthor(member.authorId) };
    });
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
    const candidates: MentionCandidate[] = [];
    for (const member of members) {
      const author = authors.get(member.authorId);
      if (!author) continue;
      const handle = author.kind === 'agent' ? this.agents.byPath(author.naturalKey)?.name : null;
      candidates.push({
        authorId: author.id,
        names: handle ? [handle, author.displayName] : [author.displayName],
      });
    }
    return candidates;
  }

  /**
   * The `responseMode` a membership is seeded with, per spec §2: the parent's
   * value in a thread, `mention-only` in a channel, the agent's manifest default
   * in a DM. Written explicitly at join time, so nothing has to re-derive it
   * later and changing the manifest never rewrites a room somebody already
   * configured.
   *
   * @param room - The room being joined.
   * @param author - The author joining.
   */
  seedResponseMode(room: Room, author: AuthorRecord): ResponseMode {
    if (room.kind === 'thread' && room.parentId) {
      const inherited = this.store.getMember(room.parentId, author.id);
      if (inherited) return inherited.responseMode;
    }
    if (room.kind === 'channel') return CHANNEL_RESPONSE_MODE;
    if (author.kind !== 'agent') return CHANNEL_RESPONSE_MODE;
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

  /** Resolve whichever of `authorId` / `agentPath` the caller supplied. */
  private resolveTarget(input: AddMemberInput): AuthorRecord {
    if (input.agentPath) {
      const agent = this.agents.byPath(input.agentPath);
      if (!agent) throw new RoomError('AGENT_NOT_FOUND', 'No agent registered at that path');
      return this.authors.resolveAgent(input.agentPath, agent.displayName);
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
