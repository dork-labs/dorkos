/**
 * Patching a room that already exists — its title, its topic, whether it is
 * put away, its four automatic-reply limits, and a bridged room's
 * `deliverNotices` override.
 *
 * **Three callers, three different answers to "who may do this", one write.**
 * That split is DOR-608's whole difficulty: {@link RoomUpdates.updateRoom} is
 * operator-only, {@link RoomUpdates.updateRoomFromTool} takes two field checks,
 * and the DM un-archive `createRoom` performs on a caller's behalf takes none
 * at all. {@link RoomUpdates.applyRoomPatch} is the half that asks nothing
 * about the caller, which is what lets all three reach it honestly.
 *
 * @module server/services/rooms/manage/room-updates
 */
import type { Room, RoomWithRoster, UpdateRoomRequest } from '@dorkos/shared/room-schemas';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { RoomAuthority } from '../service/room-authority.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomProjection } from '../service/room-projection.js';
import { slugify } from '../service/room-slugs.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';
import { eventFanOut } from '../../core/event-fan-out.js';

/**
 * The fields of an update that only the install's OWNER may send (DOR-1429).
 *
 * Listed rather than inferred, because the gate has to fire on a key that is
 * PRESENT AND `null` — clearing an override is a write like any other — and
 * `Object.hasOwn` over a named list is the only reading of "did they send this"
 * that a `null` cannot slip past. Constrained to {@link UpdateRoomRequest}'s own
 * keys, so a renamed field turns this red instead of silently guarding nothing.
 */
const ROOM_TURN_LIMIT_FIELDS = [
  'turnLimitsEnabled',
  'maxAgentDepth',
  'maxTurnsPerAgentPerCascade',
  'maxAutoTurnsPerHour',
] as const satisfies ReadonlyArray<keyof UpdateRoomRequest>;

/** Every way an existing room's own row is written. */
export class RoomUpdates {
  private readonly store: RoomStore;
  private readonly bridges: BridgeStore;
  private readonly triggers: RoomTriggerDispatcher;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly authority: RoomAuthority,
    private readonly projection: RoomProjection
  ) {
    this.store = core.store;
    this.bridges = core.bridges;
    this.triggers = core.triggers;
  }

  /**
   * Patch a room's title, topic, archived flag, its four automatic-reply limits,
   * or — on a bridged room — its `deliverNotices` override. **Operator-only**
   * (DOR-608).
   *
   * **The gate is the caller, and reaching it took a split.** Until DOR-608 this
   * method had every field check a room needs and no caller check at all, so a
   * verified agent that belonged to a room could rename it or archive it — the
   * owner's own channel included, and archive is a room-level flag everyone in
   * the room feels. The one-line `requireOperator` was a trap: it passed the
   * whole suite and broke a flow none of it covered, because `createRoom`'s
   * idempotent DM branch un-archives the conversation it matched, and the caller
   * doing that is legitimately the AGENT re-opening its own direct message. So
   * the write half moved into {@link RoomUpdates.applyRoomPatch}, which asks
   * nothing about who is calling, and the two paths that must not be gated reach
   * it without passing through here: that un-archive
   * ({@link RoomLifecycle.adoptExistingDm}) and the agent-facing
   * {@link RoomService.updateRoomFromTool}.
   *
   * **An agent's surface for a room's name and topic is `update_room`, not this
   * one** — the shape the roster verbs took in DOR-1611, a second method rather
   * than a parameter, so a surface added tomorrow gets the operator-only one by
   * default. Nothing an agent was meant to write moved out of reach: `archived`
   * and the four limit overrides were never on a tool at all.
   *
   * **A second HUMAN author is refused too**, which is the half worth stating.
   * An invited member, or a cached remote member from a community (ADR
   * 260727-184933 D6), is not this install's owner and never inherits its
   * powers — the same correction {@link RoomVisibility.seesEveryRoom} carries.
   *
   * Checked AFTER visibility and BEFORE any write, so a caller probing a room it
   * is not in learns 404 exactly as it would from reading it, and only somebody
   * who can genuinely see the room learns 403 `OPERATOR_ONLY`.
   *
   * **The four turn-limit overrides get their own SENTENCE, not their own gate**
   * (DOR-1429). They are spend authority — `turnLimitsEnabled: false` removes
   * this room's cascade guard and its hourly ceiling in one write, and
   * everything that happens next is billed to the person who owns the install —
   * so the refusal names them instead of saying "a room", which is what makes it
   * actionable in a log and in the panel that sent it. The gate itself is the
   * blanket one, which is strictly stronger and refuses exactly the same
   * callers. The install-wide twins of these fields are already `operator-only`
   * in `config-write-policy.ts`; this is the same decision at the room's grain.
   *
   * **An omitted override and an explicit `null` are different instructions.**
   * Absent leaves the stored value alone; `null` clears the override, putting
   * the room back to following Settings. Zod strips absent optional keys, so
   * the distinction survives all the way to `RoomStore.updateRoom`'s `set`.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller; must be the person who owns this install.
   * @param patch - The validated update request.
   * @returns The updated room with its roster.
   */
  updateRoom(roomId: string, viewerAuthorId: string, patch: UpdateRoomRequest): RoomWithRoster {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.authority.requireOperator(
      viewerAuthorId,
      ROOM_TURN_LIMIT_FIELDS.some((field) => Object.hasOwn(patch, field))
        ? 'how much a room may spend on automatic replies'
        : 'what a room is called, what it is about, or whether it is put away'
    );
    return this.applyRoomPatch(room, viewerAuthorId, patch);
  }

  /**
   * Rename a channel or write a room's topic as an AGENT on its roster — the
   * agent-facing half of {@link RoomService.updateRoom} (spec
   * `rooms-management-tools` §D12, DOR-1611).
   *
   * **A second method rather than a flag**, for the reason
   * {@link RoomAuthority.requireRosterWriteAllowed} gives at the roster seam: the
   * two field refusals below are the whole of what an agent has to clear, and a
   * branch inside the public method would leave that narrowness one boolean away
   * from every caller that arrives later. This one is reachable only from the
   * rooms capability domain, itself gated on the `roomsManage` grant at
   * `registry.invoke` — no route calls it.
   *
   * **`archived` is not on the signature, and the type is the point.** Putting a
   * room away is a room-level flag everyone in it feels; no tool has ever
   * offered it, and none can offer it by accident from here. The turn-limit
   * overrides cannot arrive either, for the same reason.
   *
   * @param roomId - The room to change; the caller must be able to see it.
   * @param callerAuthorId - The agent asking, already resolved.
   * @param patch - The title and topic half of an update.
   * @returns The updated room with its roster.
   */
  updateRoomFromTool(
    roomId: string,
    callerAuthorId: string,
    patch: { title?: string; topic?: string | null }
  ): RoomWithRoster {
    const room = this.visibility.requireVisibleRoom(roomId, callerAuthorId);
    this.authority.requireSystemRoomWritable(room, callerAuthorId, patch);
    this.authority.requireDmTitleWritable(room, callerAuthorId, patch);
    return this.applyRoomPatch(room, callerAuthorId, patch);
  }

  /**
   * Write a patch onto a room and tell both streams — the half of an update that
   * asks nothing about who is calling.
   *
   * **The split DOR-608 needed.** Its three callers have three different answers
   * to "who may do this": {@link RoomService.updateRoom} is operator-only,
   * {@link RoomService.updateRoomFromTool} takes two field checks, and
   * {@link RoomLifecycle.adoptExistingDm}'s un-archive takes none at all — an
   * agent asking for its own direct message again is a non-owner write that has
   * to go through. One gated method cannot serve all three, and gating the
   * method they used to share is exactly what broke the third.
   *
   * **Renaming a channel moves its `#slug` with the title.** A channel's name
   * IS its slug — it is what the sidebar draws, what a person types, and the
   * only room name the server enforces as unique (§13.1) — so a rename that
   * changed only `title` would land in the database and change nothing anybody
   * could see. The new slug is derived by the same {@link slugify} creation
   * uses, though not by the same route: creating a channel may name its slug
   * outright, and renaming one never can.
   *
   * **A rename is applied before an un-archive is judged**, so a room can come
   * back under a new name. That ordering is the difference between a channel
   * whose old name was taken while it was away being recoverable and being
   * stranded for good, because a slug is only reserved while its channel is
   * live and nothing else in the product un-archives a room.
   *
   * **`deliverNotices` lives on `room_bridges`, not `rooms`** (chats-as-channels
   * spec §6.2, D-6 Q5) — a different table from every other field this method
   * patches — so it is validated and written separately from
   * {@link RoomStore.updateRoom}'s own columns. Checked FIRST, before any write:
   * a room with no bridge has no such setting to change, and refusing early
   * means a caller who sent `{ title, deliverNotices }` for an unbridged room
   * never sees a half-applied rename.
   *
   * @param room - The room as it stands, already resolved and visible to the caller.
   * @param viewerAuthorId - The caller, for the roster projection and for naming
   *   a slug collision in terms they are allowed to hear.
   * @param patch - The validated update.
   * @returns The updated room with its roster.
   */
  applyRoomPatch(room: Room, viewerAuthorId: string, patch: UpdateRoomRequest): RoomWithRoster {
    const roomId = room.id;
    const { deliverNotices, ...roomPatch } = patch;
    if (deliverNotices !== undefined && !this.bridges.findBridgeByRoom(roomId)) {
      throw new RoomError('NOT_A_BRIDGED_ROOM', 'This room is not bridged to an external chat');
    }
    // Resolved FIRST, because the slug this room is about to have is the one an
    // un-archive has to be judged against — not the one it is leaving behind.
    const slugPatch = this.renamedSlug(room, roomPatch.title, viewerAuthorId);
    const nextSlug = slugPatch.slug ?? room.slug;
    // Un-archiving reclaims a slug the partial unique index released when the
    // room was archived. Somebody may have taken it since — refuse the same way
    // creating it would, rather than letting the raw UNIQUE violation surface
    // as a 500 the caller cannot act on. Renaming in the same patch is the way
    // out: `{ archived: false, title: 'Backend two' }` reclaims a free slug.
    if (roomPatch.archived === false && room.archived && room.kind === 'channel' && nextSlug) {
      const holder = this.store.findLiveChannelBySlug(nextSlug);
      if (holder && holder.id !== room.id) {
        this.visibility.refuseSlugTaken(nextSlug, holder.id, viewerAuthorId);
      }
    }
    const updated = this.store.updateRoom(roomId, { ...roomPatch, ...slugPatch });
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    // Putting a room away ends what it was waiting for. An archived room takes
    // no new posts, so an answer that arrived later could not be written into it
    // anyway — and the lane must stop saying one is coming. Only on the
    // TRANSITION: re-patching an already-archived room is not a second archiving.
    if (updated.archived && !room.archived) this.triggers.abandonHolds(roomId);
    // Written AFTER the room-table update settles, so a slug conflict throws
    // before this bridge-row write ever runs — the two tables never disagree
    // about whether this call actually went through.
    if (deliverNotices !== undefined) {
      this.bridges.setDeliverNotices(roomId, deliverNotices);
    }
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return this.projection.withRoster(updated, viewerAuthorId);
  }

  /**
   * The `slug` half of a channel rename, as a patch fragment to spread.
   *
   * Empty for anything that is not a channel getting a new title — only a
   * channel has a name people type, so only a channel has a slug to move. That
   * guard is load-bearing: without it a direct message would be given one.
   *
   * Refuses a title with nothing sluggable in it, and one that slugs onto a name
   * another LIVE channel holds. An archived channel's slug is not reserved, so
   * it never blocks a rename; {@link updateRoom} is where that matters, because
   * it judges an un-archive against the slug the room is about to have.
   *
   * @param room - The room being patched.
   * @param title - The requested title, when the patch carries one.
   * @returns `{ slug }` when the slug moves, otherwise `{}`.
   */
  private renamedSlug(
    room: Room,
    title: string | undefined,
    viewerAuthorId: string
  ): { slug?: string } {
    if (title === undefined || room.kind !== 'channel') return {};
    const slug = slugify(title);
    if (!slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number in it'
      );
    }
    // A cosmetic rename — `#Backend` to `Backend ` — slugs to what the channel
    // is already called. Returning early skips a lookup and a no-op write; the
    // `holder.id !== room.id` test below would reach the same verdict, so this
    // is an optimisation and not the guard against self-conflict.
    if (slug === room.slug) return {};
    const holder = this.store.findLiveChannelBySlug(slug);
    if (holder && holder.id !== room.id) {
      this.visibility.refuseSlugTaken(slug, holder.id, viewerAuthorId);
    }
    return { slug };
  }
}
