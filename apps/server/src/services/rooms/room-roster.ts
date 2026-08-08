/**
 * The membership half of the room domain: who is in a room, how they behave in
 * it, and where they have read up to.
 *
 * **"Where they have read up to" is two facts on one field** (team-room-home
 * spec §D4). A membership row stores the AGENT-side cursor — what the ambient
 * participation loop has shown that member; a person's own place in the room is
 * a row in `read_cursors`. Every projection here reports whichever answers for
 * the member it is describing, so a reader finds one number on the wire and
 * never has to know which table it came from.
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
import type {
  AuthorKind,
  AuthorRef,
  Room,
  RoomMember,
  RoomRosterEntry,
} from '@dorkos/shared/room-schemas';
import {
  addressableHandles,
  isLiveAuthor,
  rosterMentionCandidates,
  type RosterCandidates,
} from './handles/author-handles.js';
import {
  authorOrigin,
  toAuthorRef,
  type AuthorRecord,
  type AuthorRegistry,
} from './author-registry.js';
import type { ReadCursorService } from '../core/read-cursor-service.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';

/**
 * The membership seed a channel gets (room-participation spec §9.4).
 *
 * `engaged`, not `mention-only`. The old seed taxed a person with an `@` on
 * every single message, which is the top complaint in both upstream trackers;
 * `always` is agent dominance by construction, because a participant that never
 * has to think cannot lose the race to speak. `engaged` is the only bounded
 * option, because it decays — see `engagement.ts`.
 *
 * Changing this constant changes NEW joins only. The value is written explicitly
 * at join time and stays written, so migration 0039 is what moved the
 * memberships that already existed.
 */
const CHANNEL_RESPONSE_MODE: ResponseMode = 'engaged';

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
  /** Where the PEOPLE on a roster have read up to. Never an agent's cursor. */
  private readonly readCursors: ReadCursorService;

  constructor(deps: {
    store: RoomStore;
    authors: AuthorRegistry;
    agents: RoomAgentLookup;
    readCursors: ReadCursorService;
  }) {
    this.store = deps.store;
    this.authors = deps.authors;
    this.agents = deps.agents;
    this.readCursors = deps.readCursors;
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
    return { ...member, author: toAuthorRef(author), origin: authorOrigin(author.naturalKey) };
  }

  /**
   * The membership row an external person's first message writes, ready to be
   * inserted inside that message's own transaction (chats-as-channels §4.2).
   *
   * **Returned rather than written**, and that shape is the requirement. An
   * external human joins on their FIRST MESSAGE — not at bridge time, so a
   * group of two hundred does not project two hundred rows for people who never
   * spoke — and the join has to land in the same transaction as the entry, or a
   * crash between them leaves a room log holding a message from somebody its
   * roster says was never there. `RoomService.postExternal` is what composes
   * the two.
   *
   * `responseMode` is {@link RoomRoster.seedResponseMode}'s own answer, which
   * for a non-agent is the inert enum default: the field decides when an AGENT
   * answers unprompted, and nothing ever auto-triggers a person.
   *
   * @param room - The bridged room they are writing into.
   * @param author - Their author row, already resolved.
   */
  externalJoin(
    room: Room,
    author: AuthorRecord
  ): { roomId: string; authorId: string; responseMode: ResponseMode; joinedAt: string } {
    return {
      roomId: room.id,
      authorId: author.id,
      responseMode: this.seedResponseMode(room, author),
      joinedAt: new Date().toISOString(),
    };
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
   * Advance the AGENT-side read cursor on a membership. Monotonic — a lower
   * value is ignored, so a stale caller cannot un-read a room for a second one.
   *
   * **A person's cursor does not come through here** (team-room-home spec §D4).
   * This column is what the ambient participation loop has shown a member;
   * where a PERSON has read is `read_cursors`, and `RoomService.setReadCursor`
   * is the one place that decides which of the two a caller is moving.
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
   * This is the projection a mention picker reads, so each member's `handle` is
   * the one that reaches them IN THIS ROOM: an author whose agent is gone still
   * carries a handle on its row and no longer answers to it, and offering that
   * in a picker would insert a mention that reaches nobody.
   *
   * **`lastReadSeq` is the cursor that answers for each member, not the column
   * it happens to be stored in** (team-room-home spec §D4): a person's own,
   * from `read_cursors`, and an agent's membership column. One extra query for
   * the whole roster, on the read every room open already makes — this is what
   * puts the reader's own place in the room on the wire, which is what the
   * "New messages" rule is drawn from.
   *
   * @param roomId - The room.
   */
  list(roomId: string): RoomRosterEntry[] {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    const read = this.readCursors.listForThread('room', roomId);
    // The addressable set comes from `author-handles.ts`, over the SAME candidate
    // sequence `addressingCandidates` hands `resolveMentions` — so a handle is
    // offered only when it would actually reach the member it is offered for,
    // and the roster an agent reads cannot disagree with the roster a picker
    // reads.
    const handles = addressableHandles(rosterMentionCandidates(members, authors, this.agents).live);
    return members.map((member) => {
      const author = authors.get(member.authorId);
      if (!author) return { ...member, ...unknownMember(member.authorId) };
      return {
        ...member,
        lastReadSeq: cursorFor(member, author.kind, read),
        author: toAuthorRef(author, handles.get(member.authorId) ?? null),
        origin: authorOrigin(author.naturalKey),
      };
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
   * **The liveness question is asked here too**, even though nothing on this
   * path opens a picker. `AuthorRef.handle` promises that `null` means "cannot
   * be addressed", and an author whose agent is gone still carries a handle on
   * its row while answering to nothing — so handing the raw column out here
   * would make one projection of the same field disagree with the other two.
   * That is the second-derivation failure this whole area exists to prevent, and
   * a promise the schema makes is not one a bulk path gets to opt out of.
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
      if (!author) {
        byRoom.get(member.roomId)?.push(unknownMember(member.authorId).author);
        continue;
      }
      // Per author rather than per room: liveness is a property of the author's
      // directory, not of the room it is being listed in, so one lookup answers
      // for every room it appears in.
      const addressable = isLiveAuthor(author, this.agents) ? undefined : null;
      byRoom.get(member.roomId)?.push(toAuthorRef(author, addressable));
    }
    return byRoom;
  }

  /**
   * The names each member answers to for `@` resolution — their handle, and
   * nothing else — plus the handle a member whose agent is gone WOULD have
   * answered to, so typing it is answered instead of swallowed
   * (ADR 260801-003051).
   *
   * **`augment` is the one platform translation a bridged room needs** (spec
   * §5.4). Telegram addresses a bot as `@botusername`, which is not the agent's
   * DorkOS handle, so `ingest` threads one extra candidate name for the bound
   * agent here — sourced from `getMe().username`, never rewritten into the log.
   * It is **appended after** that agent's own handle, so the resolver's
   * first-claimant-wins rule keeps the agent's real handle preferred and, across
   * the roster, means the extra name can never displace a handle another member
   * already claims (A5.5). Matched on the agent's
   * `agentPath` (its author's natural key), so it lands on the bound agent and
   * nobody else; a room with no such agent (a ghost, or the wrong path) is left
   * exactly as it was.
   *
   * @param roomId - The room.
   * @param augment - Extra `@`-names for the bound agent, keyed by its
   *   `agentPath`. Omitted everywhere except a bridged room's inbound path.
   */
  addressingCandidates(
    roomId: string,
    augment?: { agentPath: string; names: readonly string[] }
  ): RosterCandidates {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((m) => m.authorId));
    const candidates = rosterMentionCandidates(members, authors, this.agents);
    if (!augment || augment.names.length === 0) return candidates;

    // The bound agent's author id, resolved from the path its author is keyed
    // on — the same key `resolveAgent` mints on, so this matches the one agent
    // the binding names and not, say, a second agent that happens to render the
    // same. Absent (a ghost, or a path with no live author here): nothing to
    // augment, and the roster is returned untouched.
    const boundAuthorId = [...authors.values()].find(
      (a) => a.kind === 'agent' && a.naturalKey === augment.agentPath
    )?.id;
    if (!boundAuthorId) return candidates;

    return {
      ...candidates,
      live: candidates.live.map((candidate) =>
        candidate.authorId === boundAuthorId
          ? { ...candidate, names: [...candidate.names, ...augment.names] }
          : candidate
      ),
    };
  }

  /**
   * The `responseMode` a membership is seeded with: `engaged` in a channel, the
   * agent's manifest default in a DM. Written explicitly at join time, so
   * nothing has to re-derive it later and changing the manifest never rewrites a
   * room somebody already configured.
   *
   * There is no third case. A thread is a position inside a channel, not a room
   * (ADR 260728-022013), so a reply there reads the channel's membership and
   * there is nothing to inherit — the branch that copied a parent's value into a
   * thread membership retired with the child room.
   *
   * The field describes when an AGENT answers without being addressed. Humans
   * and the system are never auto-triggered — addressing filters to agent
   * members — so for them it is inert, and they get the enum's own default
   * rather than a restriction nothing enforces and nobody chose.
   *
   * @param room - The room being joined, of which only its KIND is read. Narrow
   *   on purpose: `RoomService` asks this question about a room that does not
   *   exist yet, and a whole-`Room` parameter made it assemble a plausible row
   *   for columns nothing here looks at — which is a fiction the next person has
   *   to maintain every time the table gains one.
   * @param author - The author joining.
   */
  seedResponseMode(room: Pick<Room, 'kind'>, author: AuthorRecord): ResponseMode {
    if (author.kind !== 'agent') return INERT_RESPONSE_MODE;
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

  /**
   * Attach one resolved author to one membership, reporting the cursor that
   * answers for them — the single-member form of what {@link RoomRoster.list}
   * does in bulk, so one entry never disagrees with the roster it came from.
   */
  private withAuthor(member: RoomMember): RoomRosterEntry {
    const author = this.authors.getById(member.authorId);
    if (!author) return { ...member, ...unknownMember(member.authorId) };
    return {
      ...member,
      lastReadSeq:
        author.kind === 'human'
          ? (this.readCursors.get(member.authorId, 'room', member.roomId)?.lastReadSeq ?? 0)
          : member.lastReadSeq,
      author: toAuthorRef(author),
      origin: authorOrigin(author.naturalKey),
    };
  }
}

/**
 * The read cursor that answers for one member: a person's own, from
 * `read_cursors`, or an agent's membership column (team-room-home spec §D4).
 *
 * A person with no row has read nothing, which is 0 — never the membership
 * column standing in for it. Reading one cursor to answer the other's question
 * is precisely what the split forbids, and the membership column of a person who
 * predates it is frozen historical residue (migration 0059).
 *
 * @param member - The membership row.
 * @param kind - What the member is.
 * @param read - Every person's cursor in this room, from one query.
 */
function cursorFor(member: RoomMember, kind: AuthorKind, read: Map<string, number>): number {
  if (kind !== 'human') return member.lastReadSeq;
  return read.get(member.authorId) ?? 0;
}

/**
 * Placeholder for a membership whose author row has vanished. Rendering
 * "Unknown" is honest; dropping the row would silently shrink a roster.
 *
 * `origin: 'local'` because there is no key left to read one off, and the row it
 * pairs with already renders as the room's own voice rather than as a person.
 * Nothing reaches this state today — an author row is retired, never deleted —
 * so it is a placeholder for a corrupt database rather than a case with
 * behaviour riding on it.
 */
function unknownMember(id: string): Pick<RoomRosterEntry, 'author' | 'origin'> {
  return { author: { id, kind: 'system', displayName: 'Unknown', handle: null }, origin: 'local' };
}
