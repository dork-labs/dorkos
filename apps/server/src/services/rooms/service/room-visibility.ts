/**
 * Who may see a room, who may read its log, and who may touch its files.
 *
 * **Visibility is not membership, and keeping the two apart is this module's
 * whole job.** The owner may SEE every room on the install — nothing on their
 * own machine hides from them — while reading a room's log is a membership
 * even for them. Both refusals are the same `ROOM_NOT_FOUND` a missing room
 * gets, deliberately: a room id is never a capability, so a caller holding one
 * can never tell "exists, not yours" from "does not exist".
 *
 * Every request-driven path in this domain enters through one of these, which
 * is why they live in one place: a second copy of a visibility predicate is
 * the copy that gets it wrong.
 *
 * @module server/services/rooms/service/room-visibility
 */
import type { Room, RoomMember } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import { RoomError } from '../room-errors.js';
import type { RoomCore } from './room-core.js';
import type { RoomStore } from '../room-store.js';

/** The visibility and read-access rules every room verb is gated on. */
export class RoomVisibility {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(core: RoomCore) {
    this.store = core.store;
    this.authors = core.authors;
    this.isOwnerAuthor = core.isOwnerAuthor;
  }

  /**
   * Fetch a room or throw the typed not-found the routes map to a 404.
   *
   * Unscoped — for server-internal writes only (`postNotice`, whose author is
   * the system and is deliberately on no roster). Every request-driven path
   * uses {@link RoomVisibility.requireVisibleRoom} instead.
   */
  requireRoom(roomId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  /**
   * Fetch a room the caller is entitled to see, or throw.
   *
   * The single visibility rule for every request-driven path. It reports the
   * same `ROOM_NOT_FOUND` for "no such room" and "not visible to you" on
   * purpose: distinguishing them would let an agent holding a room id — and the
   * identity header is attribution, not authorization
   * (`middleware/agent-identity.ts`) — confirm that the operator's DM with
   * another agent exists by probing for a different error code.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller's author id.
   */
  requireVisibleRoom(roomId: string, viewerAuthorId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room || !this.canSee(roomId, viewerAuthorId)) {
      throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    }
    return room;
  }

  /**
   * Whether this caller may see a room at all: the owner may see every room,
   * everybody else only the ones they belong to.
   */
  canSee(roomId: string, viewerAuthorId: string): boolean {
    if (this.seesEveryRoom(viewerAuthorId)) return true;
    return this.store.getMember(roomId, viewerAuthorId) !== null;
  }

  /**
   * The owner sees every room; nothing on their own machine hides from them.
   *
   * This used to read `kind === 'human'`, which was only ever the same question
   * while an install minted exactly one human author. A second one — an invited
   * person — would have passed it and read every room on the install, the
   * owner's DMs with agents included.
   *
   * The grant is by OWNERSHIP of the install, not by membership in a room: it
   * covers every room the agents she manages hold, agent-to-agent DMs
   * included, whether or not she is on the roster — `listRooms` and `canSee`
   * both read it before checking `room_members` at all. A second human never
   * inherits this: `requireOperator` and this method answer the same author id
   * and no other, so an invited person sees exactly the rooms she is in, same
   * as an agent.
   *
   * It also does not reach past this install. When a room's truth lives in a
   * remote community, that community lists its own rooms per-caller through
   * the `CommunityAdapter` port (`GET /api/rooms` aggregates every OTHER
   * configured community alongside this one) — this machine's owner power is
   * scoped to the rooms `RoomService` itself owns, and grants nothing on a
   * community that answers for itself.
   */
  seesEveryRoom(viewerAuthorId: string): boolean {
    return this.isOwnerAuthor(viewerAuthorId);
  }

  /**
   * Refuse anyone who is not on this room's roster, and answer with the room.
   *
   * The public face of {@link RoomVisibility.requireHistoryFloor}'s first half, for
   * the surfaces that need the membership rule without a read floor — today the
   * room-repo verbs (spec `project-rooms` §3.6), which are membership-gated for
   * exactly the reason the history reads are: a room id is not a capability, and
   * seeing a room is not being in it.
   *
   * The floor is dropped rather than exposed because there is nothing to floor:
   * a room's repo is one tree with one history, not a per-member view, and a
   * member who joined yesterday merges into the same `main` as one who was there
   * from the start.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller.
   * @returns The room.
   * @throws {RoomError} `ROOM_NOT_FOUND` when the caller cannot see the room OR
   *   is not a member of it — deliberately the same answer for both.
   */
  requireMembership(roomId: string, viewerAuthorId: string): Room {
    return this.requireHistoryFloor(roomId, viewerAuthorId).room;
  }

  /**
   * The floor a member may read from in a room, refusing anyone who may not read
   * it at all.
   *
   * Shared by both history tools so the three scope rules are enforced once. A
   * member row is required even for the owner, who can SEE every room on the
   * install: reading a room's log is a membership, not a visibility.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller.
   * @returns The room, and the exclusive `seq` floor — entries strictly above it
   *   are readable. The room rides along because the one caller that needs it
   *   ({@link RoomService.exportRoom}) would otherwise read it a second time to
   *   get what this method already had in its hand.
   */
  requireHistoryFloor(roomId: string, viewerAuthorId: string): { room: Room; floor: number } {
    const { room, member } = this.requireMemberRoom(roomId, viewerAuthorId);
    return { room, floor: member.joinedSeq };
  }

  /**
   * A room the caller is genuinely ON THE ROSTER of, or the not-found every
   * other refusal in this file uses — the gate under `read_room_history`,
   * `search_room_history`, `exportRoom` and `get_room`.
   *
   * One method rather than the same four lines in each of them, because the
   * rule they share is subtle in exactly the way a second copy gets wrong:
   * visibility is NOT membership. {@link RoomVisibility.requireVisibleRoom} passes
   * the install's owner for every room on the machine, so a read that stopped
   * there would hand the owner a room they never joined; the explicit member row
   * is what makes reading a room's log a membership. And the refusal is the
   * same `ROOM_NOT_FOUND` a missing room gets, deliberately: a room id is not a
   * capability, and a distinct code here would let a caller holding an id tell
   * "exists, not yours" from "does not exist".
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller.
   * @returns The room and the caller's own membership row.
   * @throws {RoomError} `ROOM_NOT_FOUND` for a missing room and for a room the
   *   caller is not a member of, alike.
   */
  requireMemberRoom(roomId: string, viewerAuthorId: string): { room: Room; member: RoomMember } {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    const member = this.store.getMember(roomId, viewerAuthorId);
    if (!member) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return { room, member };
  }

  /**
   * Refuse anything that is not a person.
   *
   * **One verb takes it now, and it used to be two.** Reactions were the other,
   * on the strength of etiquette E16b; ADR 260814-195522 reverses that, so an
   * agent may put an emoji on a message and {@link ReactionBudget} — not this
   * gate — is what bounds it. The kind check moved because the thing being
   * protected turned out to be volume, not authorship: an acknowledgment from a
   * colleague is worth having, and a hundred of them are not.
   *
   * **Agents do not stop each other.** A halt cuts every in-flight turn in a
   * room; an agent reaching for it would be electing itself referee over its
   * room-mates, which is the arbitration this domain has declined twice
   * (ADR 260726-170125). The verb belongs to the person watching.
   *
   * A 403 rather than a 404: the caller is a member of a room it can see, so
   * there is nothing left to hide, and telling an agent "this is not yours to
   * send" is more useful than pretending the entry vanished.
   *
   * An author row that has vanished is refused too — the same conservative read
   * `post` takes when it cannot find one, since the only thing this decides is
   * whether a non-person gets to act on a person's behalf.
   *
   * @param authorId - The caller.
   * @param what - What they were trying to do, for the refusal's own words.
   */
  requirePersonAuthor(authorId: string, what: string): void {
    if (this.authors.getById(authorId)?.kind === 'human') return;
    throw new RoomError('PEOPLE_ONLY', `Only people ${what}`);
  }

  /**
   * Refuse a channel name that is already spoken for, naming the room that
   * holds it only to a caller who can already see that room (DOR-1611 review).
   *
   * **A `#slug` is a name, and a name is a thing an agent may not be entitled
   * to.** Channel slugs are unique across the whole install, so this refusal is
   * unavoidable — but the sentence it used to carry was not. "A channel called
   * #payroll already exists" told a caller that a room exists which it cannot
   * list, read, or find, in a domain whose standing rule is that a room id is
   * never a capability and "not a member" answers exactly as "no such room".
   *
   * So the message splits on {@link RoomVisibility.canSee}: the owner sees every
   * room on her machine and loses nothing by being told which one took the name
   * — that is the cockpit's whole error message today — while a caller who
   * cannot see the holder is told only that the name is taken, which it has to
   * be told, and nothing about the room that took it.
   *
   * The refusal is IDENTICAL in code and in shape either way, so the split is a
   * difference in how much is said and never in whether the call succeeded.
   *
   * @param slug - The slug that is already held.
   * @param holderRoomId - The room holding it.
   * @param viewerAuthorId - The caller.
   * @throws {RoomError} Always — `SLUG_TAKEN`.
   */
  refuseSlugTaken(slug: string, holderRoomId: string, viewerAuthorId: string): never {
    throw new RoomError(
      'SLUG_TAKEN',
      this.canSee(holderRoomId, viewerAuthorId)
        ? `A channel called #${slug} already exists`
        : 'That name is already taken. Choose a different one.'
    );
  }

  /**
   * Refuse anyone who may not attach a file to this room, before a single byte
   * is read.
   *
   * The same two gates `post` applies, in the same order and with the same
   * answers, because an upload is the first half of a message: a caller who
   * cannot see the room gets the `ROOM_NOT_FOUND` every other room read gives —
   * never a 403, which would confirm the room exists — and an archived room
   * refuses `ROOM_ARCHIVED`. Exposed rather than duplicated in the route so the
   * upload route cannot become the one place that leaks existence.
   *
   * @param roomId - The room the file is being uploaded into.
   * @param authorId - Who is uploading.
   */
  assertCanAttach(roomId: string, authorId: string): void {
    const room = this.requireVisibleRoom(roomId, authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (!this.store.getMember(roomId, authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
  }

  /**
   * Refuse anyone who may not read this room's own files (spec `project-rooms`
   * §3.9).
   *
   * **Exactly the history gate, and deliberately not a new one.** It goes
   * through the same {@link RoomVisibility.requireHistoryFloor} the room's log,
   * its search and its export go through, so "not a member" answers as "no such
   * room" and a room id is never a capability. An agent that is a member may
   * read, the same way it may read history — a room's files are what its
   * members are working on together, and an agent member is one of them.
   *
   * Three deliberate differences from the neighbours:
   *
   * - **The `joinedSeq` floor is discarded.** It is a rule about a
   *   CONVERSATION: what was said before you arrived is not yours to read back.
   *   Files have no `seq` and carry no such rule — a repo is the state of the
   *   work, not a record of who said what when, and a member who could see only
   *   the files added since they joined would be looking at a tree with holes
   *   in it. The membership half of that gate is what this borrows, and the
   *   membership half is the part that protects anything.
   * - **An archived room still reads.** Archiving stops a room, and
   *   `RoomRepoService` keeps every byte on disk on purpose; refusing to show
   *   an archived room's files would hide work nobody agreed to delete.
   * - **It says nothing about whether the room HAS files.** That question is
   *   `RoomRepoService.hasRepo`'s and is asked afterwards, so that a non-member
   *   cannot tell a project room from any other.
   *
   * Exposed rather than duplicated in the route, for the reason
   * {@link RoomService.assertCanAttach} is: a second copy of a visibility
   * predicate is the copy that gets it wrong.
   *
   * @param roomId - The room whose files are being read.
   * @param authorId - Who is asking.
   * @throws {RoomError} `ROOM_NOT_FOUND` for a room this caller may not see AND
   *   for one they are not on the roster of — the same answer, on purpose.
   */
  assertCanReadFiles(roomId: string, authorId: string): void {
    this.requireHistoryFloor(roomId, authorId);
  }

  /**
   * Refuse anyone who may not SAVE one of this room's own files (spec
   * `project-rooms` §3.10).
   *
   * The read gate plus two, and both additions are the point:
   *
   * - **People only.** An agent in a project room already has a writable
   *   working copy of its own and a merge to bring work back through; letting it
   *   write into the integration tree as well would be a second writer in the
   *   one tree the DOR-500 boundary keeps for the server, and a way to put
   *   something on `main` without the merge's validation ever looking at it. So
   *   an agent is refused here, and the refusal is a 403 that says so rather
   *   than a 404 — it is a member of a room it can see, and there is nothing
   *   left to hide.
   * - **Not archived.** Archiving stops a room. Its files stay exactly where
   *   its members left them and can still be READ, which is the point of
   *   keeping them; what stops is anybody adding to them.
   *
   * @param roomId - The room whose file is being saved.
   * @param authorId - Who is asking.
   * @throws {RoomError} `ROOM_NOT_FOUND` for a room this caller may not see and
   *   for one they are not on the roster of alike, `ROOM_ARCHIVED`, or
   *   `PEOPLE_ONLY`.
   */
  assertCanWriteFiles(roomId: string, authorId: string): void {
    const { room } = this.requireHistoryFloor(roomId, authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    this.requirePersonAuthor(authorId, 'can save a room’s files. Merge your work instead.');
  }

  /**
   * Whether this caller may READ one stored attachment.
   *
   * Two rules, and the split is the whole access model:
   *
   * - A **bound** attachment is readable by anyone who may read the entry that
   *   carries it, which is anyone who may see the room. Any other rule would
   *   let a person read a message and not the file it is about.
   * - An **unbound** attachment is readable only by whoever uploaded it, so the
   *   composer can draw its own chip and nobody can enumerate a stranger's
   *   staging area.
   *
   * @param roomId - The room.
   * @param authorId - The caller.
   * @param attachment - The row, as the route read it.
   * @returns `true` when the bytes may be served.
   */
  canReadAttachment(
    roomId: string,
    authorId: string,
    attachment: { entryId: string | null; authorId: string }
  ): boolean {
    if (attachment.entryId === null) return attachment.authorId === authorId;
    return this.canSee(roomId, authorId);
  }
}
