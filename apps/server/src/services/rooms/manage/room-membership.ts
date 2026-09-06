/**
 * Who is in a room, and how they behave once they are.
 *
 * **Each verb comes in two, and that is deliberate** (DOR-1611). The plain
 * name is operator-only and is what the routes, the community adapter and the
 * team-room hook use; the `FromTool` twin swaps that one gate for
 * {@link RoomAuthority.requireRosterWriteAllowed} and is reachable only from
 * the rooms capability domain, itself gated on the `roomsManage` grant. Every
 * refusal BELOW the gate is shared, because each is a field check — what the
 * roster will look like afterwards — and widening the caller cannot widen any
 * of them. A surface added tomorrow gets the operator-only method by default,
 * which is the whole point of the split being two methods rather than a flag.
 *
 * @module server/services/rooms/manage/room-membership
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { directMessageTitle, isDirectMessageTitleDerived } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { AuthorRecord } from '../author-registry.js';
import { buildBridgeSecondAgentRefusedNotice } from '../notices/notice-copy.js';
import type { RoomAuthority } from '../service/room-authority.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import { dmTitleNames, type AddMemberInput, type RoomRoster } from '../room-roster.js';
import type { RoomStore } from '../room-store.js';
import type { RoomSystemPosts } from '../messages/room-system-posts.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Every write that changes who is in a room. */
export class RoomMembership {
  private readonly store: RoomStore;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  private readonly triggers: RoomTriggerDispatcher;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;
  /** The record-based twin of {@link RoomMembership.isOwnerAuthor}. */
  private readonly isOwnerRecord: (record: AuthorRecord) => boolean;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly authority: RoomAuthority,
    private readonly systemPosts: RoomSystemPosts
  ) {
    this.store = core.store;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.triggers = core.triggers;
    this.isOwnerAuthor = core.isOwnerAuthor;
    this.isOwnerRecord = core.isOwnerRecord;
  }

  /**
   * Add a member by author id, or by agent directory when the agent has never
   * been an author before.
   *
   * **The owner, or an agent that belongs to this room** — no longer
   * operator-only (spec `rooms-management-tools` §D7, DOR-1611). A second person
   * is still refused. {@link RoomAuthority.requireRosterWriteAllowed} owns that
   * sentence; every refusal below it is a field check that never asked who was
   * calling, so all of them hold unchanged for the new caller.
   *
   * **A bridged room refuses a second agent** (chats-as-channels spec §3.4,
   * D-6 Q3). Outbound consent to the platform (`canReply` / `canInitiate`) is
   * set per BINDING, and a binding names exactly one agent — a second agent
   * added here would have no consent switch that names its own deliveries,
   * so `checkSender` would correctly deny every one of them. That produces the
   * worst shape of all: a room where one agent answers into the platform chat
   * and the other answers only into the cockpit, with nothing telling either
   * person why. The refusal is visible in two places: a `bridge_second_agent_
   * refused` notice posted into the room BEFORE this throws, and the thrown
   * `BRIDGE_SECOND_AGENT_REFUSED`.
   *
   * **A room the owner is not ON THE ROSTER of refuses a SECOND agent** — the
   * three-way rule (ADR 260814-025326), held here and not only at creation. An
   * agent may open a room with a colleague, and the owner's membership is the
   * price; without this check the price could be paid at creation and taken back
   * one call later, by adding the second agent to a room the owner had already
   * left, or to one an agent opened alone. Membership rather than visibility is
   * the whole of what is being protected — see
   * {@link RoomAuthority.requireSeedingAllowed}, which owns that reasoning.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; the owner, or a member agent.
   * @param input - Who to add, and optionally how they should behave.
   */
  addMember(roomId: string, viewerAuthorId: string, input: AddMemberInput): RoomRosterEntry {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.authority.requireOperator(viewerAuthorId, 'who is in a room');
    return this.addMemberTo(room, input);
  }

  /**
   * Add a member because an AGENT asked — `add_room_members`, and the rooms
   * capability domain is the only caller (DOR-1611).
   *
   * {@link RoomService.addMember} with one check swapped and nothing else moved:
   * {@link RoomAuthority.requireOperator} becomes
   * {@link RoomAuthority.requireRosterWriteAllowed}, which also admits an agent
   * that belongs to this room. Every refusal below the gate is shared, because
   * they are FIELD checks that never asked who was calling — the three-way rule,
   * the bridged-room refusal, the system-room rule — so widening the caller
   * cannot widen any of them.
   *
   * **A separate method rather than a parameter, and that is the point of it.**
   * The grant that makes this safe (`roomsManage`) is enforced at
   * `registry.invoke` and nowhere else, so it protects the CAPABILITY and not the
   * method. Keeping the widened caller check on a method only the capability
   * calls is what stops the grant from being walked around: `addMember` stays
   * operator-only for the HTTP route, the community adapter and the team-room
   * hook, and a surface added tomorrow gets the operator-only one by default.
   * `postFromTool` is the same shape for the same reason.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The calling agent, resolved from its identity.
   * @param input - Who to add.
   */
  addMemberFromTool(
    roomId: string,
    viewerAuthorId: string,
    input: AddMemberInput
  ): RoomRosterEntry {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.authority.requireRosterWriteAllowed(
      this.roster.requireAuthor(viewerAuthorId),
      'who is in a room'
    );
    return this.addMemberTo(room, input);
  }

  /**
   * The roster write both add paths share, below whichever caller check let them
   * in. Every refusal here is a FIELD check — what the roster will look like
   * afterwards — so it holds identically for the operator and for an armed agent.
   *
   * @param room - The room, already resolved and visible to the caller.
   * @param input - Who to add.
   */
  addMemberTo(room: Room, input: AddMemberInput): RoomRosterEntry {
    const roomId = room.id;

    // Resolved once here and again inside `RoomRoster.add` below — harmless:
    // resolving an agent path is idempotent (it mints the author row at most
    // once and returns the same row thereafter), and threading a pre-resolved
    // author through `add` would widen a seam every other caller of
    // `RoomRoster.add` shares, for one caller.
    const candidate = this.roster.resolve(input);
    // Who the title named before this call, when there is a title that follows
    // its roster at all. Read BEFORE the add, because "was this name written by
    // us" can only be asked of the roster the name was written from.
    let priorTitleNames: string[] | null = null;
    if (candidate.kind === 'agent') {
      const roster = this.roster.list(roomId);
      if (room.kind === 'dm') priorTitleNames = dmTitleNames(roster);
      if (this.bridges.findBridgeByRoom(roomId)) {
        const existingAgent = roster.find((member) => member.author.kind === 'agent');
        // Re-adding the room's OWN bound agent is a harmless idempotent no-op
        // one call down (`RoomStore.addMember`'s `onConflictDoNothing`) — the
        // refusal is about a SECOND, DIFFERENT agent, not about this agent
        // already being here.
        if (existingAgent && existingAgent.authorId !== candidate.id) {
          this.systemPosts.postNotice(
            roomId,
            buildBridgeSecondAgentRefusedNotice(candidate.displayName)
          );
          throw new RoomError(
            'BRIDGE_SECOND_AGENT_REFUSED',
            'A bridged room can hold only one agent — outbound consent is set per binding'
          );
        }
      }
      // The roster this call is about to produce. The candidate is UNIONED in
      // rather than appended, because re-adding somebody already on the roster
      // is a no-op one call down — counting them twice would refuse a call that
      // changes nothing.
      this.authority.requireOwnerWitnessesAgents(
        [
          ...roster
            .filter((member) => member.authorId !== candidate.id)
            .map((member) => ({ authorId: member.authorId, kind: member.author.kind })),
          { authorId: candidate.id, kind: candidate.kind },
        ],
        'add'
      );
    }

    const member = this.roster.add(room, input);
    eventFanOut.broadcast('room_member_added', { roomId, authorId: member.authorId });
    this.followRosterTitle(room, priorTitleNames);
    return member;
  }

  /**
   * Re-title a group message that has just gained an agent, when its name was
   * one this product wrote rather than one a person typed (DOR-772).
   *
   * A direct message is named after who is in it, and until now that name was
   * written once and never looked at again — so a conversation called "Ana" went
   * on being called "Ana" after Kai joined it, and the sidebar row named one of
   * the two agents in it. Now the name follows the roster.
   *
   * **A name somebody chose is never touched**, which is the whole of
   * {@link isDirectMessageTitleDerived}: the rename happens only while the
   * current title is exactly what this product would have written for the roster
   * as it was a moment ago. Rename a conversation "Launch" and it stays "Launch"
   * however many agents join it.
   *
   * Broadcast like any other rename, so open cockpits move the name rather than
   * waiting for a reload.
   *
   * @param room - The room as it was before the add.
   * @param priorTitleNames - The agents the title named a moment ago, or `null`
   *   when this room's title never followed a roster (a channel, or a join that
   *   added a person).
   */
  followRosterTitle(room: Room, priorTitleNames: readonly string[] | null): void {
    if (priorTitleNames === null) return;
    if (!isDirectMessageTitleDerived(room.title, priorTitleNames)) return;
    const title = directMessageTitle(dmTitleNames(this.roster.list(room.id)));
    if (title === '' || title === room.title) return;
    const updated = this.store.updateRoom(room.id, { title });
    if (!updated) return;
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
  }

  /**
   * Change one membership's per-room response mode. **Operator-only** — this is
   * the setting that decides when an agent answers without being addressed, so
   * an agent able to turn it up on a room-mate could manufacture a conversation.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param authorId - The member being changed.
   * @param responseMode - The new override.
   */
  updateMembership(
    roomId: string,
    viewerAuthorId: string,
    authorId: string,
    responseMode: ResponseMode
  ): RoomRosterEntry {
    this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.authority.requireOperator(viewerAuthorId, 'how an agent answers in a room');
    return this.roster.setResponseMode(roomId, authorId, responseMode);
  }

  /**
   * Remove a member, dropping its per-room session binding with it.
   *
   * **The owner, or an agent that belongs to this room** — no longer
   * operator-only (spec `rooms-management-tools` §D7, DOR-1611), with one
   * refusal that exists only for the new caller: **an agent may never take the
   * PERSON out of a room, in any shape.** That is stronger than the three-way
   * rule below and deliberately so — the owner's membership is the guarantee the
   * whole arrangement rests on, and an agent must not be able to spend it.
   *
   * **The owner cannot be taken out of a room two agents share** — the
   * three-way rule (ADR 260814-025326). This is the half of the rule that
   * refuses the OWNER, and it has to exist: a guarantee that the person is a
   * MEMBER wherever two agents talk — on the roster, with the read cursor and
   * the unread count that only membership carries — is worth nothing if the way
   * to break it is to leave afterwards. Taking an AGENT out is never refused, so
   * the room is never wedged — one agent out, and the person may go.
   *
   * **Nor out of a SYSTEM room at all** — {@link RoomAuthority.requireSystemRoomKeepsOwner},
   * checked first because it is the narrower, unconditional refusal: the
   * three-way rule above would happily let the owner leave #team, which ships
   * seated with exactly one agent (DorkBot's fallback seat), and nothing
   * restores the membership afterwards (`ensureSystemChannel` returns an
   * existing row untouched).
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; the owner, or a member agent.
   * @param authorId - The member being removed.
   */
  removeMember(roomId: string, viewerAuthorId: string, authorId: string): void {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.authority.requireOperator(viewerAuthorId, 'who is in a room');
    this.removeMemberFrom(room, authorId);
  }

  /**
   * Remove a member because an AGENT asked — `remove_room_members` and
   * `leave_room`, and the rooms capability domain is the only caller (DOR-1611).
   *
   * {@link RoomService.removeMember} with the operator gate swapped for
   * {@link RoomAuthority.requireRosterWriteAllowed}, plus the two refusals that
   * exist only for this caller. Everything below them is shared and unchanged.
   *
   * **A separate method rather than a parameter**, for the reason
   * {@link RoomService.addMemberFromTool} gives in full: the `roomsManage` grant
   * guards the CAPABILITY, not the method, so the widened caller check has to
   * live somewhere only the capability can reach.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The calling agent, resolved from its identity.
   * @param authorId - The member being removed; the caller itself when leaving.
   */
  removeMemberFromTool(roomId: string, viewerAuthorId: string, authorId: string): void {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    const caller = this.roster.requireAuthor(viewerAuthorId);
    this.authority.requireRosterWriteAllowed(caller, 'who is in a room');
    // **An agent may never take the person out of a room, in any shape.** This
    // is STRONGER than the three-way rule below it, deliberately (spec §D7 row
    // 4, operator-settled): that rule refuses the owner's removal only once two
    // agents would remain, whereas the owner's membership is the guarantee the
    // whole arrangement rests on — an agent must not be able to spend it, not
    // even in a room where the shape rules would permit it.
    //
    // Ordered BEFORE the field checks under it, which is what keeps their
    // messages honest: `requireOwnerWitnessesAgents`'s `'remove'` wording is
    // addressed to the person, and this guard is why an agent can never read it.
    if (!this.isOwnerRecord(caller) && this.isOwnerAuthor(authorId)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can take yourself out of a room');
    }
    // **An agent removing ITSELF is leaving, whatever verb it used to ask**
    // (DOR-1611 review). The two refusals that make `leave_room` safe used to
    // live only in {@link RoomService.leaveRoom}, so `remove_room_members` with
    // the caller's own handle in the list walked straight past both: an agent
    // could leave a DM it can never re-enter, and could take itself out of
    // #team — where nothing restores the seat, and where the fallback-seat
    // clear below would empty the seat on the way out. Same act, same rules,
    // whichever door it came through.
    //
    // Not conditioned on the caller being an agent, because this method has no
    // other kind: `requireRosterWriteAllowed` above admits the owner too, and
    // she reaches roster writes through `removeMember` rather than here. The
    // owner-check is kept anyway so the rule reads the same as it enforces.
    if (caller.id === authorId && !this.isOwnerRecord(caller)) {
      this.requireLeavingAllowed(room);
    }
    this.removeMemberFrom(room, authorId);
  }

  /**
   * The roster write both remove paths share, below whichever caller check let
   * them in. Every refusal here is a FIELD check — what the roster will look like
   * afterwards — so it holds identically for the operator and for an armed agent.
   *
   * @param room - The room, already resolved and visible to the caller.
   * @param authorId - The member being removed.
   */
  removeMemberFrom(room: Room, authorId: string): void {
    const roomId = room.id;
    this.authority.requireSystemRoomKeepsOwner(room, authorId);
    if (this.isOwnerAuthor(authorId)) {
      this.authority.requireOwnerWitnessesAgents(
        this.roster
          .list(roomId)
          .filter((member) => member.authorId !== authorId)
          .map((member) => ({ authorId: member.authorId, kind: member.author.kind })),
        'remove'
      );
    }
    this.roster.remove(roomId, authorId);
    // The fallback seat is CLEARED when its holder leaves, never defended by a
    // refusal (spec `rooms-management-tools` §D9, DOR-1611).
    //
    // **A correctness fix for every caller of this method, not a new rule for
    // the new ones.** `rooms.fallback_seat_author_id` is deliberately not a
    // foreign key (`packages/db/src/schema/rooms.ts`), so nothing cleaned it up
    // and a room could sit naming a seat that is not on its roster — a message
    // addressed to nobody in particular then reached nobody at all, silently.
    // Removing the holder through the cockpit had that effect long before an
    // agent could ask for it.
    //
    // Cleared rather than refused because refusing would WEDGE the seat-holder
    // into a room it could never leave — the identical failure mode that made
    // defending it the wrong answer, and the reason the standing guarantee
    // "taking an AGENT out is never refused, so nothing is ever wedged" holds.
    if (room.fallbackSeatAuthorId === authorId) {
      this.store.setFallbackSeat(roomId, null);
    }
    // Whatever this room was still waiting for from this agent is over: it is
    // not here to answer it. Dropped rather than left to age out, because the
    // wait can now last up to `rooms.lateReplyCeilingMinutes` and the live lane
    // would go on promising an answer for all of it. No notice — see
    // `RoomTriggerDispatcher.abandonHolds` for why the removal is its own
    // durable, visible sibling.
    this.triggers.abandonHolds(roomId, authorId);
    eventFanOut.broadcast('room_member_removed', { roomId, authorId });
  }

  /**
   * Step out of a channel you are in (spec `rooms-management-tools` §D9,
   * DOR-1611).
   *
   * {@link RoomService.removeMember} with the caller as its own target, plus
   * {@link RoomMembership.requireLeavingAllowed} — the two refusals that are about
   * LEAVING rather than about editing a roster, and which that method documents
   * in full.
   *
   * **It is not the only door to those refusals, which is why they are not
   * written here.** `remove_room_members` with the caller's own handle in the
   * list reaches `removeMember` directly, so the rules have to hold there too.
   *
   * @param roomId - The channel to leave.
   * @param authorId - The member leaving; always the caller itself.
   * @throws {RoomError} `ROOM_NOT_FOUND` when the caller cannot see the room,
   *   `TOOL_LEAVE_NOT_IN_DM` in anything that is not a channel, and
   *   `SYSTEM_ROOM` in a well-known one.
   */
  leaveRoom(roomId: string, authorId: string): void {
    const room = this.visibility.requireVisibleRoom(roomId, authorId);
    // Checked here as well as inside `removeMember`, and that is not a
    // duplicate: this method means "a member is walking out" for ANY caller,
    // while the copy below it fires only for an agent removing itself. Keeping
    // both is what stops the guarantee from depending on who happens to call.
    this.requireLeavingAllowed(room);
    this.removeMemberFromTool(roomId, authorId, authorId);
  }

  /**
   * The two refusals that are about WALKING OUT rather than about editing a
   * roster (spec `rooms-management-tools` §D9, DOR-1611).
   *
   * They live on the service, not in the capability that calls it, because the
   * cockpit may legitimately take an agent out of either kind of room: these are
   * not roster rules, they are rules about a member choosing to leave. And they
   * live in ONE method because there are two doors to that act —
   * {@link RoomService.leaveRoom} and {@link RoomService.removeMember} with the
   * caller as its own target — and a rule written at one door is a rule the
   * other one does not have.
   *
   * **Channels only.** A channel can be re-entered and a direct message cannot:
   * `findDmByMemberSet` needs an EXACT member-set match, so re-opening a DM
   * somebody left mints a SECOND conversation beside the first rather than
   * returning to it. `kind !== 'channel'` rather than `kind === 'dm'`, so an
   * unrecognized kind takes the narrower branch (`.claude/rules/room-conduct.md`).
   *
   * **Never a system room.** #team is the install's home tab and ships seated
   * with exactly one agent, whose seat nothing restores: `ensureSystemChannel`
   * is idempotent on the ROOM, not on its roster. The owner may still take an
   * agent out of #team herself — that is a decision she can see and undo.
   *
   * **Emptying an ordinary channel is deliberately NOT refused.** The last
   * member may leave, and the room survives it: the row, its `#slug` and its
   * whole history stay, the owner sees every room on the install whether or not
   * she is a member ({@link RoomVisibility.seesEveryRoom}), and she can add members
   * back. Refusing would wedge the last member into a room it could never leave
   * — the same failure mode that made defending the fallback seat wrong.
   *
   * @param room - The room being walked out of.
   * @throws {RoomError} `TOOL_LEAVE_NOT_IN_DM` in anything that is not a
   *   channel, and `SYSTEM_ROOM` in a well-known one.
   */
  requireLeavingAllowed(room: Room): void {
    if (room.kind !== 'channel') {
      throw new RoomError(
        'TOOL_LEAVE_NOT_IN_DM',
        'You can only leave a channel. This is a direct message — it stays until the person archives it.'
      );
    }
    if (room.wellKnown) {
      // Sanitized, unlike its twin on `requireSystemRoomWritable`: this sentence
      // is read by a MODEL, in a room whose title the operator typed and no
      // write path sanitizes on the way in, so an unsanitized title here is
      // untrusted text arriving inside an instruction (DOR-1611 review). The
      // `#slug` branch needs none — a slug is `[a-z0-9-]` by construction.
      throw new RoomError(
        'SYSTEM_ROOM',
        `You can't leave ${room.slug ? `#${room.slug}` : (sanitizeIdentity(room.title) ?? 'this room')} — it's the home channel for this install. Ask the person who runs it if you should be out of it.`
      );
    }
  }
}
