/**
 * What happens to a bridged room after it exists: disconnecting one,
 * re-bridging a chat whose bridge row survived, and the two small writes the
 * bridge makes on the way in (chats-as-channels spec §3.5, §7.3).
 *
 * The bridge ROW is the identity here, never the roster — a chat is resolved
 * on `(adapterId, chatId)` because that pair is the natural key, and the row
 * outlives the archived flag so a re-bridge finds the whole log where it left
 * it.
 *
 * @module server/services/rooms/manage/room-bridge-lifecycle
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { RoomAuthority } from '../service/room-authority.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import {
  buildBridgeAgentSwappedNotice,
  buildBridgeDisconnectedNotice,
  buildBridgeHistoryNotice,
} from '../notices/notice-copy.js';
import type { RoomProjection } from '../service/room-projection.js';
import type { RoomRoster } from '../room-roster.js';
import { slugify, uniqueChannelSlug } from '../service/room-slugs.js';
import type { OpenedRoom } from '../service/room-service-deps.js';
import type { RoomStore } from '../room-store.js';
import type { RoomSystemPosts } from '../messages/room-system-posts.js';
import type { RoomUpdates } from './room-updates.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/**
 * Input to {@link RoomService.rebridge} — re-bridging a chat that already has a
 * surviving (archived) bridge row (chats-as-channels spec §3.5). Resolved
 * through the bridge store on `(adapterId, chatId)`, never the roster: the chat
 * is the natural key that identifies the room, and the row outlives the flag.
 */
export interface RebridgeRequest {
  /** The relay adapter instance this chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /**
   * The binding that now owns this bridge. May differ from the row's current
   * `bindingId` — a binding is re-created rather than re-pointed, so even a
   * re-bridge to the SAME agent can carry a fresh binding id.
   */
  bindingId: string;
  /**
   * The agent to bind. When it resolves to the room's current bound agent this
   * is a plain reuse; when it resolves to a different one it is the agent swap
   * (§3.5, A3.6b), which adopts the surviving row and its whole log.
   */
  agentPath: string;
  /** The operator's author id. Re-bridging acts as the operator, like the create path. */
  operatorAuthorId: string;
}

/** Disconnecting, re-bridging, and the bridge's own small writes. */
export class RoomBridgeLifecycle {
  private readonly store: RoomStore;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly authority: RoomAuthority,
    private readonly projection: RoomProjection,
    private readonly updates: RoomUpdates,
    private readonly systemPosts: RoomSystemPosts
  ) {
    this.store = core.store;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.isOwnerAuthor = core.isOwnerAuthor;
  }

  /**
   * Archive a bridged room and stamp its bridge row archived — the room half of
   * §3.5's unbind, bot-kick, and out-of-band-archive paths.
   *
   * **The disconnect notice is posted BEFORE the archive, because it must be.**
   * `postNotice` refuses an archived room, so the room's own voice records the
   * disconnect while it still can — the last line in the log, which is exactly
   * where a person scrolling back later looks for why the chat went quiet. A
   * room already archived out of band (§10.9) skips both the notice and the
   * archive and only stamps the bridge row, so this method is safe to call on a
   * room whose archive it did not itself perform.
   *
   * **The bridge row and every external ref survive (§3.5).** Only `archivedAt`
   * is stamped, and only when it is not already set — so a re-bridge finds the
   * row, its refs, and the room's whole log intact, and echo suppression and
   * reply targeting keep working across the gap. Clearing the binding's own
   * `bridge`/`roomId` is the caller's half (`BridgeLifecycle`): the binding is a
   * relay concern this domain does not write.
   *
   * @param roomId - The bridged room to archive.
   * @param operatorAuthorId - The install owner; the bridge always acts as them.
   * @param opts.reason - The platform's own words for why, when the disconnect
   *   was forced rather than chosen (bot blocked or kicked, §10.3). Written into
   *   the notice; omitted for a plain operator unbridge.
   */
  archiveBridgedRoom(
    roomId: string,
    operatorAuthorId: string,
    opts: { reason?: string } = {}
  ): void {
    const room = this.visibility.requireVisibleRoom(roomId, operatorAuthorId);
    this.authority.requireOperator(operatorAuthorId, 'whether a chat is connected');
    const bridge = this.bridges.findBridgeByRoom(roomId);
    if (!bridge) {
      throw new RoomError('NOT_A_BRIDGED_ROOM', 'This room is not bridged to an external chat');
    }
    if (!room.archived) {
      this.systemPosts.postNotice(roomId, buildBridgeDisconnectedNotice(opts.reason));
      this.updates.updateRoom(roomId, operatorAuthorId, { archived: true });
    }
    if (bridge.archivedAt === null) {
      this.bridges.archiveBridge(roomId, new Date().toISOString());
    }
  }

  /**
   * Re-bridge a chat that still has a surviving bridge row (chats-as-channels
   * spec §3.5) — the lifecycle path `createBridgedRoom` deliberately refuses
   * with `CHAT_ALREADY_BRIDGED`. Resolved through the bridge store on
   * `(adapterId, chatId)`, never the roster, because the chat is the natural key
   * and the row is the identity.
   *
   * Two shapes, decided by whether the requested agent is the one the room
   * already holds:
   *
   * - **Same agent — reuse.** Un-archive the room and the bridge row and hand it
   *   back. The log, the refs, and the agent's own `(room, agent)` session are
   *   all where they were, so the conversation simply resumes (A3.6). When the
   *   binding id changed under it — a binding is re-created, not re-pointed — the
   *   row is re-pointed to match, but nothing else moves and no notice is
   *   posted: nothing about the conversation changed.
   * - **Different agent — adopt and swap (A3.6b).** The surviving row's
   *   `UNIQUE (adapter_id, chat_id)` makes a second room impossible, and that is
   *   the right answer: minting a parallel room would strand this chat's history.
   *   So the rebind ADOPTS the room. The old agent leaves the roster and its
   *   `(room, agent)` session is dropped with it (orphaned, never migrated); the
   *   new agent joins with its mode seeded ATOMICALLY IN THE `RoomRoster.add`
   *   call — `mention-only` on a bridged channel, the manifest default on a
   *   bridged dm — so there is no observable instant where a swapped-in channel
   *   agent is anything but mention-gated, the same invariant the create path
   *   holds (§3.4). The bridge row is re-pointed to the new binding, and ONE
   *   notice posted into the room names the swap. The room keeps its id, title,
   *   slug and every external ref, so echo suppression and reply targeting stay
   *   continuous.
   *
   * The mode is seeded in the `add`, and every write that could fail — the
   * re-point, the notice — runs AFTER it, so a failure anywhere past the add
   * still leaves the swapped-in agent correctly gated (A3.6b's simulated-failure
   * assertion). Setting the binding's own `bridge`/`roomId` back on is the
   * caller's half (`BridgeLifecycle`).
   *
   * @param request - Which chat, which binding, which agent, and the operator.
   * @returns The re-bridged room with its roster; `created` is always `false` —
   *   re-bridging never mints a room.
   */
  rebridge(request: RebridgeRequest): OpenedRoom {
    const operator = this.roster.requireAuthor(request.operatorAuthorId);
    if (!this.isOwnerAuthor(operator.id)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can bridge a chat');
    }

    const bridge = this.bridges.findBridgeByChat(request.adapterId, request.chatId);
    if (!bridge) {
      throw new RoomError(
        'NO_SURVIVING_BRIDGE',
        'This chat has no bridge to re-bridge; create one instead'
      );
    }
    const room = this.store.getRoom(bridge.roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'The bridged room no longer exists');
    }

    const currentAgentMember = this.roster
      .list(room.id)
      .find((member) => member.author.kind === 'agent');
    const newAgent = this.roster.resolve({ agentPath: request.agentPath });
    const sameAgent = currentAgentMember?.authorId === newAgent.id;

    // Un-archive first — both shapes bring the room back to life, and the swap's
    // notice below cannot be posted into an archived room. The bridge row's
    // `archivedAt` is cleared to match, so `postExternal` accepts inbound again.
    // A CHANNEL un-archives onto a freshly-resolved unique slug so re-bridging
    // never throws `SLUG_TAKEN` on a platform-sourced title (§3.4, A3.4) — see
    // {@link RoomBridgeLifecycle.unarchiveBridgedRoom}.
    //
    // **The room-half writes from here down are NOT one transaction, on
    // purpose.** Each is a separate synchronous commit on this single-connection
    // `better-sqlite3` database — un-archive room, un-archive row, remove old
    // member, add new, re-point row, post notice — and they deliberately do not
    // share a `tx` handle: `RoomStore.removeMember`/`addMember` and the
    // bridge-store writers take none, and widening those seams for this one
    // caller is exactly the coupling `addMember`'s own doc argues against. The
    // recovery contract stands in for atomicity: this whole method is idempotent
    // under retry, because it re-reads the surviving row and the CURRENT roster
    // every time. A throw after the old agent is removed but before the new one
    // is added leaves an agent-less, un-archived room; re-running `rebridge`
    // finds no agent member, takes the different-agent branch, and adds the new
    // one. A throw after the add but before the re-point leaves the new agent
    // seeded correctly (A3.6b) and the row still on the old binding; re-running
    // sees the new agent already present, takes the same-agent branch, and
    // finishes the re-point. The only write a retry does not replay is the swap
    // notice — best-effort by design (`notices/notice-log.ts`'s degrade contract),
    // never the durable state.
    if (room.archived) this.unarchiveBridgedRoom(room);
    this.bridges.unarchiveBridge(bridge.roomId);

    if (!sameAgent) {
      // Old agent leaves, taking its (room, agent) session with it (§3.5) — the
      // store drops the `room_sessions` row inside `removeMember`.
      if (currentAgentMember) {
        this.roster.remove(room.id, currentAgentMember.authorId);
        eventFanOut.broadcast('room_member_removed', {
          roomId: room.id,
          authorId: currentAgentMember.authorId,
        });
      }
      // Seeded IN the add, never patched after — mention-only on a bridged
      // channel, the manifest default on a dm (§3.4). This is the write A3.6b
      // proves durable even when a later step throws.
      const responseMode: ResponseMode | undefined =
        room.kind === 'channel' ? 'mention-only' : undefined;
      const added = this.roster.add(room, { agentPath: request.agentPath, responseMode });
      eventFanOut.broadcast('room_member_added', { roomId: room.id, authorId: added.authorId });
    }

    // Re-point the row to the binding that now owns it — for the swap always,
    // and for a same-agent reuse only when the binding id actually changed. Runs
    // AFTER the add so a failure here cannot un-seed the mode above.
    if (bridge.bindingId !== request.bindingId) {
      this.bridges.rebindBridge(bridge.roomId, request.bindingId);
    }

    if (!sameAgent) {
      const oldName = currentAgentMember?.author.displayName ?? 'the previous agent';
      this.systemPosts.postNotice(
        room.id,
        buildBridgeAgentSwappedNotice(oldName, newAgent.displayName)
      );
    }

    const fresh = this.visibility.requireRoom(room.id);
    return { ...this.projection.withRoster(fresh, operator.id), created: false };
  }

  /**
   * Bind a session adopted at bridge time into the `(room, agent)` ledger
   * (chats-as-channels spec §7.3, step 3).
   *
   * **First-write-wins, so it MUST run before the room's first turn.** The
   * dispatcher mints a fresh id for a `(room, agent)` pair that has never
   * answered ({@link RoomStore.bindRoomSession} via `room-trigger.ts`); writing
   * the adopted id here first means that mint is a no-op and the first turn
   * resumes the adopted conversation instead of starting the agent over. That
   * ordering is the whole mechanism A7.1 asserts on — the transcript the turn
   * receives, not this row.
   *
   * The room log is deliberately NOT touched: the earlier messages stay in the
   * adopted session's own runtime-owned transcript and are never copied here
   * (§7.3, ADR-0310). The pointer notice ({@link buildBridgeHistoryNotice}) is
   * the only thing the log gains, and the adopter posts it.
   *
   * @param roomId - The bridged room.
   * @param agentAuthorId - The bound agent's author id in this room.
   * @param sessionId - The session the bridge adopted, already transcript-probed.
   */
  bindAdoptedSession(roomId: string, agentAuthorId: string, sessionId: string): void {
    this.store.bindRoomSession(roomId, agentAuthorId, sessionId, new Date().toISOString());
  }

  /**
   * Post the one-line history notice a bridge writes at creation
   * (chats-as-channels spec §7.3): where the conversation's earlier messages
   * live, and that this channel's own record starts now.
   *
   * @param roomId - The freshly bridged room.
   * @param priorSession - `true` when an existing session was adopted (the
   *   pointer variant), `false` when the bridge started fresh (pointer-less).
   */
  postBridgeHistoryNotice(roomId: string, priorSession: boolean): void {
    this.systemPosts.postNotice(roomId, buildBridgeHistoryNotice(priorSession));
  }

  /**
   * Un-archive a bridged room, giving a CHANNEL a freshly-resolved unique slug
   * so re-bridging never throws `SLUG_TAKEN` (spec §3.4, A3.4).
   *
   * A channel's slug is released when it archives, and a live channel may have
   * taken it while this one was away. {@link RoomService.updateRoom}'s un-archive
   * path refuses that collision with `SLUG_TAKEN` — correct for a room a person
   * named and can rename, wrong for a bridged channel whose title is
   * platform-sourced and whose re-bridge would then wedge on a name nobody typed
   * (and, because `rebridge` runs the room half first, wedge the binding flip
   * with it). So this mirrors the create path: {@link uniqueChannelSlug}
   * appends `-2`, `-3`, … until free — the same auto-suffix `createBridgedRoom`
   * uses — rather than throwing. The slug is resolved while the room is still
   * archived, so `findLiveChannelBySlug` cannot match the room against itself. A
   * `dm` has no slug and keeps `null`.
   *
   * Bypasses {@link RoomService.updateRoom} rather than reusing it: that method
   * derives its slug from a `title` patch (there is none here) and re-runs the
   * very `SLUG_TAKEN` guard this path exists to sidestep. The operator check it
   * would apply is already satisfied — `rebridge` validated the owner before
   * reaching here.
   *
   * @param room - The archived bridged room, snapshotted before this write.
   * @returns The un-archived room.
   */
  unarchiveBridgedRoom(room: Room): Room {
    // A `dm` keeps its `null` slug untouched — `slug` is omitted rather than
    // passed as `null`, which `RoomStore.updateRoom` does not accept.
    const patch: { archived: false; slug?: string } =
      room.kind === 'channel'
        ? { archived: false, slug: uniqueChannelSlug(this.store, slugify(room.title) ?? 'chat') }
        : { archived: false };
    const updated = this.store.updateRoom(room.id, patch);
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return updated;
  }
}
