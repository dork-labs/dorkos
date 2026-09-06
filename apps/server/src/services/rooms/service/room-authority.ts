/**
 * Who may change what about a room — the caller checks, kept apart from the
 * field checks they sit above.
 *
 * **Roster writes are the owner's — as far as identity can tell.** Adding,
 * removing, or re-configuring a member is refused for anyone the server does
 * not resolve as this install's owner. That was a harmless asymmetry while
 * nothing read `responseMode`; now that a post triggers turns, an agent that
 * could widen another agent's addressing could drive replies nobody asked for,
 * from inside the room where it is hardest to notice.
 *
 * **`updateRoom` joined that list in DOR-608.** A room's title, topic and
 * archived flag used to be writable by any member, so an agent could rename or
 * archive a room it belonged to — the owner's own channel included. The naive
 * gate was a trap, which is why it stood so long: `createRoom`'s DM un-archive
 * path re-opens a conversation on behalf of whoever asked for it, and for a DM
 * between the owner and an agent that caller is legitimately the agent. The
 * write half is now `applyRoomPatch`, which asks nothing about the caller, and
 * three callers sit above it — `updateRoom` (operator-only, what the routes and
 * the community adapter use), `updateRoomFromTool` (an agent renaming a channel
 * or writing a topic, reachable only from the `roomsManage` capability verbs),
 * and `adoptExistingDm`'s un-archive (no check, by design).
 *
 * **Two field refusals survive on the tool path**, because being an agent on the
 * roster is not enough for either. A SYSTEM room — one carrying a well-known
 * key, which today means the #team channel `ensureTeamRoom` opens at boot
 * (team-room-home spec D3.1) — refuses a rename from anyone but the owner: the
 * product renders its home tab from that room, so an agent that could rename it
 * could take the cockpit's front door with it. And a DIRECT MESSAGE cannot be
 * renamed by an agent at all, because a DM's name is its roster.
 *
 * **The gates ask who the OWNER is, never whether the author is a human**
 * (DOR-598). Those were the same question only while this table held exactly one
 * human author. It will not: joining a community fills it with other humans —
 * cached remote members whose messages you hold (ADR 260727-184933 D6) — and
 * none of them operates this machine. Ownership is injected as `isOwnerAuthor`
 * rather than read here, because whether an account exists is not a room's
 * business to know.
 *
 * Read "not the owner" literally: it means a request the server resolved to
 * somebody else. In the DEFAULT posture (`auth.enabled` off) a request carrying
 * no `X-DorkOS-Agent` header resolves to the owner, so a program on this machine
 * clears every gate in this file by omitting a header. That is the documented
 * DOR-505 residual, not a hole this domain opened or can close — with login off
 * there is nothing left to tell a local program from the person at the keyboard.
 * Turning **Require login** on is what makes these gates mean what they say.
 *
 * @module server/services/rooms/service/room-authority
 */
import type { AuthorKind, Room } from '@dorkos/shared/room-schemas';
import type { AuthorRecord } from '../author-registry.js';
import { RoomError } from '../room-errors.js';
import type { RoomCore } from './room-core.js';

/** The caller checks a room's write paths are gated on. */
export class RoomAuthority {
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;
  /** The record-based twin of {@link RoomAuthority.isOwnerAuthor}. */
  private readonly isOwnerRecord: (record: AuthorRecord) => boolean;

  constructor(core: RoomCore) {
    this.isOwnerAuthor = core.isOwnerAuthor;
    this.isOwnerRecord = core.isOwnerRecord;
  }

  /**
   * Refuse a roster write from anyone but the person who owns the install.
   *
   * Deliberately a 403 and not a 404: the caller is already a member of a room
   * it can see, so there is nothing left to hide, and telling an agent "you may
   * not" is more useful than telling it a room it just read no longer exists.
   *
   * Same correction as {@link RoomVisibility.seesEveryRoom}: on `kind === 'human'`
   * a second person could have rewritten any roster in any room.
   *
   * @param viewerAuthorId - The caller.
   * @param what - What they tried to change, for the message.
   */
  requireOperator(viewerAuthorId: string, what: string): void {
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
  }

  /**
   * Refuse a rename or an archive of a SYSTEM room from anyone but the owner
   * (team-room-home spec D3.1).
   *
   * **A field check, not a caller check**, which is what made it safe to add
   * while `updateRoom` still had no operator gate — it fires only on
   * `wellKnown`, which no DM and no caller-created room ever carries, so it
   * could never reach `createRoom`'s DM un-archive path. DOR-608 has since
   * closed the blanket hole by splitting that path off
   * ({@link RoomUpdates.applyRoomPatch}), and this refusal outlived it: it is
   * now what stops an agent renaming #team through
   * {@link RoomService.updateRoomFromTool}, the one surface that still writes a
   * room's name for a caller who is not the owner. **The `archived` half is
   * belt-and-braces** — that surface has no such field and `updateRoom` refuses
   * the caller outright — and it stays because this method is the sentence
   * "#team is not an ordinary room", not a patch on one particular route.
   *
   * **Rename and archive, not topic, and not delete.** The title is a channel's
   * address (renaming it moves the `#slug`), and archiving takes the room off
   * every list — both would break the home tab that renders #team for anybody
   * who did not ask for it. A topic is a description, and describing a shared
   * room is ordinary participation. There is no delete verb on a room at all
   * (archive is this product's reversible "put it away", spec §12.4), so
   * "nobody may delete #team" needs no code — and muting is a sidebar
   * preference in the person's own config, which never reaches this domain,
   * so the owner can still quiet the room without leaving it.
   *
   * @param room - The room being patched.
   * @param viewerAuthorId - The caller.
   * @param patch - The room-table half of the requested patch.
   */
  requireSystemRoomWritable(
    room: Room,
    viewerAuthorId: string,
    patch: { title?: string; archived?: boolean }
  ): void {
    if (!room.wellKnown) return;
    if (patch.title === undefined && patch.archived === undefined) return;
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError(
      'SYSTEM_ROOM',
      `Only you can rename or archive ${room.slug ? `#${room.slug}` : room.title}`
    );
  }

  /**
   * Refuse a non-owner renaming a DIRECT MESSAGE (orchestrator ruling on the
   * DOR-1611 review; spec `rooms-management-tools` §D12 amendment).
   *
   * **A DM's name is its roster.** The title is derived from who is in it and
   * re-derived when that set changes (`dm-title-follows-roster`), so a title an
   * agent writes there is a label with a short and unpredictable life — and for
   * as long as it lasts it has renamed a conversation that belongs to whoever
   * else is in it. A channel is the opposite case, and the one `update_room`
   * exists for: its name is what people type, and fixing a wrong one is the
   * whole verb.
   *
   * The shape is {@link RoomAuthority.requireSystemRoomWritable}'s, deliberately:
   * a FIELD check rather than a blanket gate, so the TOPIC stays writable —
   * describing a room you are in is ordinary participation. Since DOR-608 both
   * live on {@link RoomService.updateRoomFromTool}, which is the only path left
   * that writes a room's name for somebody who is not the owner.
   *
   * **The owner is exempt**, as she is there. The cockpit is the person, a name
   * she chose for her own conversation is hers to change, and the rule this
   * encodes is about an agent relabelling somebody else's room.
   *
   * @param room - The room being patched.
   * @param viewerAuthorId - The caller.
   * @param patch - The room-table half of the requested patch.
   */
  requireDmTitleWritable(room: Room, viewerAuthorId: string, patch: { title?: string }): void {
    // `!== 'channel'`, never `=== 'dm'`: `rooms.kind` is a text column narrowed
    // by an unchecked cast, so an unrecognized kind takes the narrower branch.
    if (room.kind === 'channel') return;
    if (patch.title === undefined) return;
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError(
      'TOOL_RENAME_NOT_IN_DM',
      'A direct message is named after who is in it, so it cannot be renamed. You can still set its topic.'
    );
  }

  /**
   * Refuse taking the owner off a SYSTEM room's roster (DOR-1233 follow-up to
   * team-room-home spec D3.1).
   *
   * **The three-way rule alone does not cover this.** It refuses removing the
   * owner only once a room holds two or more agents, and #team ships seated
   * with exactly one — DorkBot's fallback seat (`ensure-team-room.ts`) — so
   * leaving #team through the ordinary Leave button was reachable with no gate
   * on it at all. And unlike an ordinary room, nothing puts the membership
   * back afterwards: `ensureSystemChannel` is idempotent on the ROOM, not on
   * its roster — once #team exists, a restart returns that same row untouched.
   * #team is the install's home tab (team-room-home spec D3.2); a home with
   * nobody home is not a state this product can recover from without editing
   * the database by hand.
   *
   * A field check on `wellKnown`, the same shape as
   * {@link RoomAuthority.requireSystemRoomWritable} and for the same reason: it
   * cannot reach a DM or a caller-created channel, neither of which ever
   * carries the flag, so an ordinary room's Leave is untouched.
   *
   * @param room - The room being removed from.
   * @param authorId - The member being removed.
   */
  requireSystemRoomKeepsOwner(room: Room, authorId: string): void {
    if (!room.wellKnown) return;
    if (!this.isOwnerAuthor(authorId)) return;
    throw new RoomError(
      'SYSTEM_ROOM',
      `You can't leave ${room.slug ? `#${room.slug}` : room.title} — it's your home channel`
    );
  }

  /**
   * Refuse a non-owner's attempt to seed a room with an agent that is not
   * itself — **unless the owner is in that room too** (the three-way rule,
   * ADR 260814-025326).
   *
   * A caller opening a room for itself — a DM with the owner, a scratch channel
   * — is legitimate and has always been allowed. What changed on 2026-08-13 is
   * the case beside it: **an agent may now open a room with another agent, and
   * the price is that the person is on the roster.** Agents that can only ever
   * talk to their operator cannot divide work between themselves, which is the
   * coordination this product is for.
   *
   * **What the owner's membership buys is not visibility — she already has
   * that.** {@link RoomVisibility.seesEveryRoom} shows the owner every room on the
   * install whether or not she is on its roster, so "a conversation nobody can
   * see" was never the thing at risk. MEMBERSHIP is: only a membership carries a
   * read cursor, so only a room the owner is IN has an unread count at all
   * ({@link RoomDirectory.cursorsFor} keys on `room_members`; a non-member's is
   * `null`, which the sidebar draws as no badge). Two agents in a room she is
   * not on the roster of would talk in a row that never lights up — visible in
   * the way a file is visible, which is not the same as being told. The rule
   * makes the person a participant rather than an auditor, and it is checked
   * here rather than promised in a prompt.
   *
   * **Only an AGENT gets that escape.** A second PERSON — a member account, in
   * an install with login on — still may not put any agent in any room, owner
   * present or not. `/api/rooms` is reachable by a member (her own rooms live
   * behind it), so without that narrowness she could conscript somebody else's
   * agents into work that spends the owner's model quota with the server
   * process's filesystem access. An agent seeding a colleague is doing the job
   * it was installed to do; a guest doing it is spending an account that is not
   * theirs. Nothing asked for the second, so nothing here grants it.
   *
   * This reads owner-identity rather than `kind === 'human'` for the same reason
   * {@link RoomAuthority.requireOperator} does.
   *
   * **Creation is not the only door**, and this method is not the whole rule:
   * {@link RoomAuthority.requireOwnerWitnessesAgents} holds the same invariant at
   * `addMember` and `removeMember`, because a room that passes here could
   * otherwise be walked into the forbidden shape one membership call later.
   *
   * @param creator - The author opening the room.
   * @param seeded - Every author the new roster will hold.
   */
  requireSeedingAllowed(creator: AuthorRecord, seeded: readonly AuthorRecord[]): void {
    if (this.isOwnerAuthor(creator.id)) return;
    const conscripted = seeded.find(
      (author) => author.id !== creator.id && author.kind === 'agent'
    );
    if (!conscripted) return;
    if (creator.kind !== 'agent') {
      throw new RoomError('OPERATOR_ONLY', 'Only you can put another agent in a room');
    }
    if (seeded.some((author) => this.isOwnerAuthor(author.id))) return;
    throw new RoomError(
      'OPERATOR_ONLY',
      'Two agents can only share a room you are in — add yourself to it'
    );
  }

  /**
   * Whether this caller may change a room's roster at all (spec
   * `rooms-management-tools` §D7, DOR-1611).
   *
   * The sibling of {@link RoomAuthority.requireSeedingAllowed}, which already
   * encodes "an agent may, a second person may not" at creation. This is that
   * same sentence for the two membership verbs, and it exists because
   * {@link RoomAuthority.requireOperator} — what those verbs used to call — cannot
   * say it: that method answers exactly one question, "are you the owner", and
   * for a member agent the answer is now sometimes "no, and that is fine".
   *
   * **A second person is still refused**, which is the half worth stating.
   * An invited human is not the install's owner and never inherits its powers
   * (the same correction {@link RoomVisibility.seesEveryRoom} carries), so this
   * widens the door for AGENTS the owner armed and for nobody else.
   *
   * **`requireOperator` itself is unchanged, and four of its call sites must
   * never gain an agent path.** `setFallbackSeat` and `updateMembership` decide
   * who answers what, which is arbitration by another name (ADR 260726-170125);
   * `archiveBridgedRoom` and {@link RoomService.updateRoom} are spend authority
   * and room-level state. Only `addMember` and `removeMember` move here.
   *
   * **What this deliberately does NOT decide.** Four refusals sit beside it and
   * stay exactly where they are, because each is a FIELD check rather than a
   * caller check and therefore already holds for an agent caller with no edit:
   * a room the caller cannot see ({@link RoomVisibility.requireVisibleRoom}, which
   * runs FIRST in both verbs — a room id is never a capability), a system room
   * keeping its owner ({@link RoomAuthority.requireSystemRoomKeepsOwner}), the
   * three-way rule ({@link RoomAuthority.requireOwnerWitnessesAgents}), and a
   * bridged room refusing a second agent. The one refusal that is genuinely new
   * lives in {@link RoomService.removeMember}: an agent may never take the owner
   * out of a room, in any shape.
   *
   * **It does not decide the GRANT either, and the HTTP surface is why that
   * matters.** `roomsManage` is enforced at `registry.invoke` and nowhere else,
   * so it gates the five agent-facing TOOLS. The two HTTP roster routes
   * (`POST /api/rooms/:id/members`, `DELETE /api/rooms/:id/members/:authorId`)
   * resolve their caller from `X-DorkOS-Agent` and never pass that choke point —
   * so for one commit, when this check replaced `requireOperator` on
   * {@link RoomService.addMember} and {@link RoomService.removeMember}
   * themselves, an agent could step around the grant with a direct request. That
   * was a REGRESSION rather than an inherited gap: before it, those two methods
   * were unconditionally operator-only and refused every agent token.
   *
   * **So this check is not reachable from a route at all.** It guards only
   * {@link RoomService.addMemberFromTool} and
   * {@link RoomService.removeMemberFromTool}, which nothing but the rooms
   * capability domain calls; `addMember`/`removeMember` kept their operator gate
   * and are what the routes, the community adapter and the team-room hook use.
   * An agent's roster surface is the capability verbs, full stop — and a surface
   * added tomorrow gets the operator-only method by default, which is the point
   * of the split being two methods rather than a parameter.
   *
   * @param caller - The author asking, already resolved.
   * @param what - What they are changing, for the refusal's own words.
   */
  requireRosterWriteAllowed(caller: AuthorRecord, what: string): void {
    if (this.isOwnerRecord(caller)) return;
    if (caller.kind === 'agent') return;
    throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
  }

  /**
   * Hold the three-way rule across a membership change: **a room that holds two
   * or more agents holds the owner too** (ADR 260814-025326).
   *
   * The same invariant {@link RoomAuthority.requireSeedingAllowed} settles at
   * creation, asked of the roster a membership call is about to produce. Both
   * are needed, and the reason is that either one alone is a door standing open:
   * a create the gate allows could be walked into an owner-less pair by adding
   * an agent afterwards, and an owner who may leave any room could empty herself
   * out of a room her two agents are talking in. Neither is a caller check, and
   * that is what has kept this correct through DOR-1611: the caller used to be
   * the owner always, because both membership verbs were `requireOperator`, and
   * is now sometimes an armed agent ({@link RoomAuthority.requireRosterWriteAllowed}).
   * This guard did not have to change, because it never asked who was calling —
   * it asks what the roster will LOOK like afterwards. **It refuses the owner
   * herself**, which is the point: the guarantee is about the shape of the room,
   * not about who asked for it.
   *
   * It is deliberately compositional rather than provenance-based. Nothing
   * records who opened a room — `rooms` has no `created_by` column — and adding
   * one would make the rule "an AGENT-seeded pair needs a witness" while leaving
   * a pair the owner seeded and then walked out of just as unattended. Asking
   * the roster instead needs no column and covers both.
   *
   * **A property of these two write verbs, not of the data already on disk.** A
   * room that reached the forbidden shape before this rule existed keeps
   * running, keeps triggering, and is never retro-refused; nothing sweeps the
   * table. What is closed is every way to REACH that shape from here.
   *
   * **Removing an agent is never refused**, so a room is never wedged: when
   * this refuses the owner's own removal (a direct Leave — DOR-1233), the way
   * through is to take an agent out first and leave afterwards, or to archive
   * the room instead. There is still no delete (spec §12.4).
   *
   * **The `'remove'` wording still addresses the owner, and that is sound rather
   * than stale.** It reads "take one of them out before you leave it", which
   * would be nonsense said to an agent — but the branch is reachable only when
   * the member being removed IS the owner, and an agent asking for that is
   * already refused one guard earlier ({@link RoomService.removeMember}'s
   * owner-removal check). So the only caller who can ever read this sentence is
   * the person it is written for. Do not "fix" it without moving that guard.
   *
   * @param roster - The roster as it will be AFTER the change.
   * @param what - What the caller was doing, for the refusal's own words.
   */
  requireOwnerWitnessesAgents(
    roster: readonly { authorId: string; kind: AuthorKind }[],
    what: 'add' | 'remove'
  ): void {
    if (roster.filter((member) => member.kind === 'agent').length < 2) return;
    if (roster.some((member) => this.isOwnerAuthor(member.authorId))) return;
    throw new RoomError(
      'OWNER_MUST_BE_PRESENT',
      what === 'add'
        ? 'Two agents can only share a room you are in — join it first'
        : 'Two agents share this room — take one of them out before you leave it'
    );
  }
}
