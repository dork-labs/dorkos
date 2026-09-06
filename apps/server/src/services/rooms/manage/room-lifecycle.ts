/**
 * Opening a room: the caller-facing create, the direct-message adoption that
 * makes it idempotent, and the two boot-hook verbs that seat a system channel.
 *
 * @module server/services/rooms/manage/room-lifecycle
 */
import { ulid } from 'ulidx';
import type { CreateRoomRequest, Room } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { AuthorRecord } from '../author-registry.js';
import type { RoomAuthority } from '../service/room-authority.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomProjection } from '../service/room-projection.js';
import type { RoomRoster } from '../room-roster.js';
import type { NewRoom } from '../room-rows.js';
import { slugify, uniqueChannelSlug } from '../service/room-slugs.js';
import type { OpenedRoom } from '../service/room-service-deps.js';
import { isDmMemberSetTaken, type RoomStore } from '../room-store.js';
import type { RoomUpdates } from './room-updates.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Every way a room comes into existence. */
export class RoomLifecycle {
  private readonly store: RoomStore;
  private readonly roster: RoomRoster;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly authority: RoomAuthority,
    private readonly projection: RoomProjection,
    private readonly updates: RoomUpdates
  ) {
    this.store = core.store;
    this.roster = core.roster;
  }

  /**
   * Open a channel or a DM, seeding its roster with the creator and whoever the
   * request names — by author id (`members`) or by agent directory
   * (`agentPaths`).
   *
   * `agentPaths` is what makes a DM one call. The cockpit knows agents by
   * directory and nothing else; author ids are minted server-side and the only
   * surface that resolves one is `POST /:id/members`. So creating a DM used to
   * mean create-then-join, and a failed join left a direct message with nobody
   * in it — a room named after an agent that the agent was not in, which no
   * amount of retrying could repair because the room already existed.
   *
   * Resolve-then-create: every member is resolved before `RoomStore.createRoom`
   * is called at all, and that call writes the room and its whole roster in one
   * transaction. So an unregistered agent path fails while the room does not
   * exist, and the obvious retry works. (The resolution itself is not inside
   * that transaction — it does not need to be, and saying so would be drift.)
   *
   * **A DM is idempotent on its member set.** Ask for a direct message with
   * people you already have one with and you get that conversation back, not a
   * second one beside it. A DM is identified by WHO IS IN IT, so two rooms
   * holding the same authors are the same room told twice — the failure mode
   * Teams ships, where duplicate chats are real and you are told to rename them
   * apart. Slack behaves the way this does.
   *
   * It has to be decided here rather than in the picker for two reasons. It is
   * an idempotency property of the resource, so every caller gets it — the
   * cockpit, an MCP client, a shell. And a client could only evaluate it by
   * holding every DM's roster, which is exactly the per-room fetch R5 deleted.
   *
   * **And the DATABASE is what decides it, not the lookup below** (DOR-1616).
   * The member-set lookup used to be a query with nothing behind it, so two
   * writers could both read "no DM yet" and both insert. `rooms.dm_member_key`
   * carries the canonical roster on the room row and
   * `rooms_dm_member_key_unique` refuses the second write; the loser adopts the
   * winner's room. The lookup is still run first, because the common case is a
   * conversation that has existed for hours and answering it with a SELECT beats
   * answering it with a failed INSERT — but it is now an optimisation over a
   * guarantee rather than the guarantee itself.
   *
   * Three consequences worth stating, because none of them is obvious:
   *
   * - **An archived match is un-archived and returned.** Archive is this
   *   product's reversible "put it away" (spec §12.4 — there is no Leave), so
   *   re-opening a conversation is what asking for it again means. Minting a
   *   parallel room would strand the history in the archived one.
   * - **The existing room keeps its own title.** A request that matched is
   *   asking for a conversation, not renaming one; silently retitling a room
   *   somebody had named would be a side effect nobody asked for. Rename is its
   *   own verb (`PATCH /api/rooms/:id`).
   * - **The caller is told which one it got**, via {@link OpenedRoom.created},
   *   because nothing in the body says. This is an upsert on a natural key, not
   *   a replay of one caller's earlier answer against an idempotency key they
   *   supplied — the room this matches may have been opened by somebody else
   *   hours ago — so the honest report is PUT-shaped: 201 for a room that was
   *   created, 200 for one that was already there.
   * - **`lastActivityAt` is left alone**, on the matched path and the
   *   un-archived one alike. Opening a conversation is not activity in it, and
   *   bumping it would push a silent room to the top of a sidebar sorted by
   *   recency and tell the reader something happened. A re-opened DM comes back
   *   where it was.
   *
   * @param request - The validated create request.
   * @param creatorAuthorId - The author opening the room; joined automatically.
   * @returns The room with its roster and whether this call created it — new, or
   *   the one that already held these exact members.
   */
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): OpenedRoom {
    const slug = request.kind === 'channel' ? (request.slug ?? slugify(request.title ?? '')) : null;
    if (request.kind === 'channel' && !slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number, or give it a slug'
      );
    }
    const draft: NewRoom = {
      id: ulid(),
      kind: request.kind,
      slug,
      title: request.title ?? `#${slug ?? ''}`,
      topic: request.topic ?? null,
      createdAt: new Date().toISOString(),
    };

    // Resolve the whole roster BEFORE anything is written. An unknown author id
    // or an unregistered agent path has to fail while the room does not exist
    // yet — otherwise the caller gets a 404 for a room that is sitting in the
    // table holding its slug.
    const joinedAt = draft.createdAt;
    const creator = this.roster.requireAuthor(creatorAuthorId);
    const resolved = new Map<string, AuthorRecord>([[creator.id, creator]]);
    for (const authorId of request.members) {
      const author = this.roster.resolve({ authorId });
      resolved.set(author.id, author);
    }
    for (const agentPath of request.agentPaths) {
      const author = this.roster.resolve({ agentPath });
      resolved.set(author.id, author);
    }
    // Opening a room is not a way around the operator-only roster rule. An agent
    // may make itself a room, and may bring a colleague into one — but only into
    // a room the person is on the roster of (the three-way rule,
    // ADR 260814-025326). `addMember` and `removeMember` hold the same shape
    // afterwards, so this is a gate and not a formality.
    this.authority.requireSeedingAllowed(creator, [...resolved.values()]);

    // Also AFTER the gate, and for the same reason as the dedupe below it
    // (DOR-1611 review). A channel's `#slug` is a name the caller may not be
    // able to see: the owner sees every room, an agent sees only its own, and
    // this refusal names a room by a name that is otherwise unreachable. Run
    // BEFORE the gate it answered "a channel called #payroll already exists" to
    // a caller that could not list, read, or find that channel — a create path
    // doubling as a name oracle over the operator's private rooms. Now a caller
    // the gate refuses learns exactly what it learned about every other room:
    // nothing.
    const slugHolder = slug ? this.store.findLiveChannelBySlug(slug) : null;
    if (slug && slugHolder) this.visibility.refuseSlugTaken(slug, slugHolder.id, creatorAuthorId);

    // Deliberately AFTER that gate, not before. A caller the gate refuses gets
    // the same 403 whether or not the room it named exists, so this stays a
    // create path that sometimes answers with an existing room and never a way
    // to probe for one.
    if (request.kind === 'dm') {
      const existing = this.store.findDmByMemberSet([...resolved.keys()]);
      if (existing) return this.adoptExistingDm(existing, creatorAuthorId);
    }

    const members = [...resolved.values()].map((author) => ({
      authorId: author.id,
      responseMode: this.roster.seedResponseMode(draft, author),
      joinedAt,
    }));

    let room: Room;
    try {
      room = this.store.createRoom(draft, members);
    } catch (err) {
      // **The INSERT is what settles a concurrent DM open, not the lookup above
      // it** (DOR-1616). Two writers — a second DorkOS process, a CLI and the
      // app started together — can both read "no DM yet" and both come here, and
      // `rooms_dm_member_key_unique` makes exactly one of them win. The loser
      // ADOPTS the winner's room rather than failing, because the caller asked
      // for a conversation and there now is one: reporting a constraint error
      // would be telling them their DM does not exist while pointing at it.
      //
      // Same shape, same reasoning as `ensureSystemChannel`'s well-known-key
      // race below, including the recovery test: the re-read decides it rather
      // than an errno comparison, and a failure that did not leave the key held
      // is rethrown untouched — a channel's `SLUG_TAKEN` included, since
      // `isDmMemberSetTaken` names the column and not merely the error class.
      if (!isDmMemberSetTaken(err)) throw err;
      const won = this.store.findDmByMemberSet([...resolved.keys()]);
      if (!won) throw err;
      return this.adoptExistingDm(won, creatorAuthorId);
    }

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { ...this.projection.withRoster(room, creatorAuthorId), created: true };
  }

  /**
   * Answer a DM open with the conversation that already holds these people —
   * the matched half of {@link RoomService.createRoom}, reached both by its
   * lookup and by its adopt-the-winner recovery.
   *
   * One method rather than two copies because the two paths must be
   * indistinguishable to a caller: whether this install had the room before the
   * request or acquired it a microsecond into one, what comes back is the same
   * conversation, un-archived if it was away, with `created: false` telling the
   * caller which of the two answers they got.
   *
   * **The un-archive goes through {@link RoomUpdates.applyRoomPatch}, not
   * {@link RoomService.updateRoom}, and that is DOR-608's whole difficulty in one
   * line.** The caller here is whoever asked for the conversation, which for a
   * DM between the owner and an agent is routinely the AGENT — so this write is
   * a non-owner's and must go through, while the same write arriving at
   * `PATCH /api/rooms/:id` is refused. Visibility needs no re-check: this room
   * matched on a member set that always contains the caller, so it is a room
   * they are in by construction.
   *
   * @param existing - The DM holding exactly this member set.
   * @param creatorAuthorId - Whoever asked to open it.
   */
  adoptExistingDm(existing: Room, creatorAuthorId: string): OpenedRoom {
    // Broadcasts `room_updated`, which is what a sidebar holding a stale list
    // needs to hear. The slug-reclaim branch is channel-only, so it is inert here.
    const reopened = existing.archived
      ? this.updates.applyRoomPatch(existing, creatorAuthorId, { archived: false })
      : this.projection.withRoster(existing, creatorAuthorId);
    return { ...reopened, created: false };
  }

  /**
   * Record which member holds this room's **fallback seat** — the one that
   * answers a post nobody addressed (team-room-home spec D3.4).
   * **Operator-only**, for the same reason `updateMembership` is: the seat is
   * what makes an agent answer without being addressed, so an agent able to
   * claim it could manufacture a conversation.
   *
   * Paired with, and never a substitute for, the `always` mode on that same
   * membership: the mode is what ADDRESSING selects the seat with, and this is
   * what tells the dispatcher and the boot reconcile WHICH member the seat is —
   * a question `always` cannot answer, because a person may set any agent to
   * "Everything" themselves.
   *
   * @internal Reachable only from the `ensureTeamRoom` boot hook and the
   *   default-agent watcher beside it. Not a route and not a tool.
   * @param roomId - The room.
   * @param operatorAuthorId - The install owner.
   * @param authorId - The member taking the seat, or `null` to empty it.
   * @returns The updated room.
   */
  setFallbackSeat(roomId: string, operatorAuthorId: string, authorId: string | null): Room {
    this.visibility.requireVisibleRoom(roomId, operatorAuthorId);
    this.authority.requireOperator(operatorAuthorId, 'which agent answers what nobody addressed');
    const room = this.store.setFallbackSeat(roomId, authorId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  /**
   * Get — or open, once — the channel holding a well-known key. The write half
   * of `ensureTeamRoom` (team-room-home spec D3.1). **Operator-only.**
   *
   * **Idempotent on the key, not on the name.** A room already carrying the key
   * is returned untouched, whatever it has since been renamed to, archived to,
   * or given as a topic: this runs on every boot, and a hook that re-asserted
   * the seed values would quietly undo the person's own edits every restart.
   * The key is the identity precisely so the name is free to change.
   *
   * **Separate from {@link RoomService.createRoom} because the key must not be
   * requestable.** `CreateRoomRequest` deliberately has no `wellKnown` field —
   * a well-known key is what makes a room a system room, so an API that let a
   * caller name one would let an agent mint a room the owner alone may rename.
   * This method is reachable only from the boot hook.
   *
   * **The slug is de-collided, never stolen — and it steps over archived
   * channels too.** An install may already have an ordinary `#team` somebody
   * made; adopting it would hand a person's own channel system-room semantics
   * and a roster of every agent, so the system room takes the next free name
   * (`#team-2`) instead. An ARCHIVED `#team` is stepped over for a second
   * reason: archiving releases a slug, so a system room that took it would
   * leave that channel permanently un-un-archivable — the way back is the name
   * it left behind. See {@link uniqueChannelSlug}.
   *
   * **The find-then-insert is not atomic across processes, and the insert is
   * what settles it.** Two boots — a cockpit and a CLI started together — can
   * both read "no team room" and both try to write one; the unique key on
   * `rooms.well_known` makes exactly one of them win. The loser ADOPTS the
   * winner's row rather than failing, because a loser that gave up would leave
   * that boot with no home room and no agents seated in the one that exists.
   * The re-read decides it rather than an errno test: any insert failure is
   * re-checked against the key, and one that did not leave the key held is
   * rethrown untouched, so nothing real is swallowed.
   *
   * @internal Reachable only from the `ensureTeamRoom` boot hook. Not a route,
   *   not a tool, and deliberately not part of `CreateRoomRequest`.
   * @param wellKnown - The key this room answers to forever (`'team'`).
   * @param seed - The name and topic to open it with, used only on creation.
   * @param operatorAuthorId - The install owner, who is seeded as its first member.
   * @returns The room, and whether this call is what created it.
   */
  ensureSystemChannel(
    wellKnown: string,
    seed: { slug: string; topic?: string },
    operatorAuthorId: string
  ): { room: Room; created: boolean } {
    this.authority.requireOperator(operatorAuthorId, 'the rooms DorkOS itself depends on');
    const existing = this.store.findByWellKnown(wellKnown);
    if (existing) return { room: existing, created: false };

    const slug = uniqueChannelSlug(this.store, seed.slug, { includeArchived: true });
    const createdAt = new Date().toISOString();
    const operator = this.roster.requireAuthor(operatorAuthorId);
    let room: Room;
    try {
      room = this.store.createRoom(
        {
          id: ulid(),
          kind: 'channel',
          slug,
          title: `#${slug}`,
          topic: seed.topic ?? null,
          wellKnown,
          createdAt,
        },
        [
          {
            authorId: operator.id,
            responseMode: this.roster.seedResponseMode({ kind: 'channel' }, operator),
            joinedAt: createdAt,
          },
        ]
      );
    } catch (err) {
      const won = this.store.findByWellKnown(wellKnown);
      if (!won) throw err;
      return { room: won, created: false };
    }
    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { room, created: true };
  }
}
