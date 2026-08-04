/**
 * The bridge lifecycle: unbridge, archive, re-bridge, and the agent-swap rebind
 * (chats-as-channels spec §3.5, §10.9).
 *
 * This coordinator ties the two halves of a lifecycle event that no single
 * store owns. The **room half** — archiving and un-archiving the room, swapping
 * the roster's bound agent, posting the room's own notice — lives in
 * `RoomService` (`archiveBridgedRoom`, `rebridge`), because those are writes
 * over the room domain's own tables and its author authority. The **binding
 * half** — flipping `binding.bridge` between `'off'` and `'room'` and setting or
 * clearing `binding.roomId` — lives in the relay's `BindingStore`, which is
 * file-backed and async. Neither may reach into the other's tables, so the
 * sequencing that keeps them consistent lives here, at the one place that holds
 * both.
 *
 * **Archive is the only removal, and the room log is never trimmed** (ADR
 * 260726-170125). Every method here archives, un-archives, or re-points; none
 * deletes a room, a bridge row, an external ref, or an entry. That is what keeps
 * echo suppression and reply targeting continuous across a disconnect and a
 * re-bridge — the refs the bridge wrote on the way out are still there on the
 * way back in.
 *
 * **`ingest`/`deliver` are not here.** The inbound and outbound paths are
 * DOR-870's, and {@link BridgeLifecycle.onRoomArchivedDuringIngest} is the seam
 * they call when a committed post discovers its room was archived out of band
 * (§10.9) — this module builds the handler, not the path that catches the throw.
 *
 * @module server/services/relay/chat-bridge/lifecycle
 */
import type { ChatNoticeSender } from '@dorkos/relay';
import { logger } from '../../../lib/logger.js';
import type { BridgeStore } from './bridge-store.js';
import type { BridgeSessionAdopter } from './adopt-session.js';

/**
 * The room-domain half of a lifecycle event, as the coordinator needs it.
 *
 * A structural interface rather than an import of `RoomService`, on purpose: the
 * rooms domain already imports this package's `BridgeStore`, and importing its
 * `RoomService` back would close a cycle. `RoomService` satisfies this by
 * shape — the two methods it needs are public — so the wiring passes the real
 * service and nothing here knows the concrete class.
 */
export interface BridgeRoomOps {
  /**
   * Mint a bridged room by bridge-row identity (spec §3.2–§3.4): room, roster
   * (bound agent + operator), and `room_bridges` row in one transaction. A
   * structural mirror of `RoomService.createBridgedRoom`, so this coordinator
   * can drive it without importing the rooms domain back (see the interface
   * doc). `chatType` is widened to `string` here because `RoomService` is what
   * validates it against the closed union at the trust boundary.
   *
   * @param request - The resolved create request; `operatorAuthorId` is the
   *   install owner the coordinator supplies.
   * @returns The room's id, its roster (to find the bound agent's author id for
   *   adoption), and whether it was freshly created or an idempotent replay.
   */
  createBridgedRoom(request: {
    adapterId: string;
    chatId: string;
    bindingId: string;
    chatType: string;
    channelType: string | null;
    title: string;
    agentPath: string;
    operatorAuthorId: string;
  }): {
    id: string;
    created: boolean;
    members: ReadonlyArray<{ authorId: string; author: { kind: string } }>;
  };
  /**
   * Archive a bridged room and stamp its bridge row archived, posting the
   * disconnect notice first (spec §3.5). Safe on a room already archived out of
   * band — it then only stamps the row.
   *
   * @param roomId - The bridged room.
   * @param operatorAuthorId - The install owner; the bridge acts as them.
   * @param opts.reason - The platform's own words, when the disconnect was
   *   forced (bot blocked or kicked, §10.3).
   */
  archiveBridgedRoom(roomId: string, operatorAuthorId: string, opts?: { reason?: string }): void;
  /**
   * Re-bridge a chat with a surviving bridge row (spec §3.5): reuse it for the
   * same agent, or adopt it and swap the roster for a different one.
   *
   * @param request - Which chat, which binding, which agent, and the operator.
   * @returns The re-bridged room; only its `id` is read here.
   */
  rebridge(request: {
    adapterId: string;
    chatId: string;
    bindingId: string;
    agentPath: string;
    operatorAuthorId: string;
  }): { id: string };
}

/** The binding fields this coordinator reads. */
export interface LifecycleBinding {
  id: string;
  /** The relay adapter instance. */
  adapterId: string;
  /** The platform chat id, when the binding names one. */
  chatId?: string | null;
  /** The feature flag, per chat (spec §3.1). */
  bridge: string;
  /** The room this binding is bridged to, set iff `bridge === 'room'`. */
  roomId: string | null;
}

/**
 * The binding-store half of a lifecycle event, as the coordinator needs it —
 * read one binding, flip its `bridge`/`roomId`. A structural interface for the
 * same decoupling reason as {@link BridgeRoomOps}; the real `BindingStore`
 * satisfies it.
 */
export interface BridgeBindingWriter {
  /**
   * The binding by id, or `undefined` when there is none.
   *
   * @param id - The binding's UUID.
   */
  getById(id: string): LifecycleBinding | undefined;
  /**
   * Flip a binding's bridge fields.
   *
   * @param id - The binding's UUID.
   * @param updates - `bridge` and `roomId`; `roomId: null` clears it.
   */
  update(
    id: string,
    updates: { bridge?: 'off' | 'room'; roomId?: string | null }
  ): Promise<unknown>;
}

/** Everything {@link BridgeLifecycle} is constructed from. */
export interface BridgeLifecycleDeps {
  /** The room-domain half — the real `RoomService` in production. */
  rooms: BridgeRoomOps;
  /** The bridge identity store (spec §3.1). */
  bridges: BridgeStore;
  /** The binding store — the binding half of every flip. */
  bindings: BridgeBindingWriter;
  /**
   * Send a one-line notice into the platform chat (spec §10.9). Damped per
   * `(binding, chat, reason)` by the sender itself, which is what makes
   * {@link BridgeLifecycle.onRoomArchivedDuringIngest} tell the chat exactly
   * once even when two inbound messages race the same archive (A10.5).
   */
  chatNotice: ChatNoticeSender;
  /**
   * The install owner's author id. Read per call rather than captured, so a test
   * (or an install that gains an account partway through its life) resolves the
   * owner the wiring actually holds at the moment of the flip.
   */
  operatorAuthorId: () => string;
  /**
   * Adopts an existing chat session into a freshly bridged room, gated on a real
   * transcript probe (spec §7.3). Required only by {@link BridgeLifecycle.bridge};
   * the archive/rebridge/out-of-band paths never touch it, so it is optional and
   * a coordinator wired without it simply cannot create bridges.
   */
  adopter?: BridgeSessionAdopter;
  /**
   * Refresh the freshly created bridge's `visibility` badge from the platform
   * (spec §8's task-1.13 refresh cadence: bridge create is one of the two
   * triggers, the other being adapter start/reconnect). Optional and
   * best-effort — {@link BridgeLifecycle.bridge} awaits it but swallows a
   * failure, because a visibility check must never turn a successful bridge
   * into a failed one. Absent in a coordinator wired without an adapter
   * registry (most unit tests), in which case the room simply keeps reporting
   * `'partial'` until the next adapter reconnect.
   */
  refreshVisibility?: (adapterId: string) => Promise<void>;
}

/**
 * The bridged-room create request, as {@link BridgeLifecycle.bridge} builds it —
 * every field the room half needs except `operatorAuthorId` (the coordinator
 * supplies the install owner), plus `agentId` for the adopter's transcript probe
 * root. Mirrors `RoomService.CreateBridgedRoomRequest` structurally to keep this
 * coordinator free of a rooms import.
 */
export interface BridgeCreateInput {
  /** The relay adapter instance this chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /** The binding this bridge is a mode of. */
  bindingId: string;
  /** The bound agent's id — resolves the probe's project root (§7.3). */
  agentId: string;
  /** The platform chat type, read from `platformData.chatType` (spec §3.3). */
  chatType: string;
  /** The channel type from the relay subject, or `null` for a DM subject. */
  channelType: string | null;
  /** The raw, unsanitized platform title (the room half sanitizes it). */
  title: string;
  /** The bound agent's directory. Exactly one agent seeds a bridged room. */
  agentPath: string;
}

/** What {@link BridgeLifecycle.rebridge} needs to re-bridge a chat. */
export interface RebridgeInput {
  /** The relay adapter instance the chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /** The binding that now owns this bridge. */
  bindingId: string;
  /** The agent to bind; a different one than the room holds triggers the swap. */
  agentPath: string;
}

/**
 * The bridge lifecycle coordinator.
 *
 * Holds no state of its own — every method reads the current binding and bridge
 * rows and writes them back, so two calls never disagree about a snapshot one of
 * them captured.
 */
export class BridgeLifecycle {
  private readonly deps: BridgeLifecycleDeps;

  constructor(deps: BridgeLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * Bridge a chat for the first time: mint the room, adopt an existing session
   * if a real transcript proves one, then flip the binding on (spec §3.1–§3.4,
   * §7.3). The create-side sibling of {@link BridgeLifecycle.unbridge} and
   * {@link BridgeLifecycle.rebridge}, and the one call path session adoption runs
   * on — DOR-878's "Bridge to a channel" route resolves the binding and calls
   * this.
   *
   * The order — create, adopt, THEN flip the binding — makes the flag flip the
   * last write (§3.4 implementation 2): a failure in the adopt or the flip leaves
   * the binding `'off'` over a LIVE room, never a binding that says `'room'` over
   * a half-built room. That live room is not stranded, and there is **no startup
   * reaper** (none exists, and none is needed): a retry of `bridge()` finds the
   * surviving, un-archived bridge row, replays (`created: false`), skips adopt,
   * and re-flips — the self-heal below — and a `rebridge` of the same chat reuses
   * it (DOR-869). The room is deliberately **not archived** on failure:
   * `createBridgedRoom` refuses an archived bridge row with `CHAT_ALREADY_BRIDGED`
   * (room-service.ts), so archiving it would turn that retry-heal into a hard 409
   * — the room stays live precisely so the retry can reach the replay branch. The
   * only lasting residue is a fresh-mint failure the operator never retries and
   * never re-bridges: an unreferenced room with its binding `'off'`, which nothing
   * routes to (inbound only bridges when `bridge === 'room'`) and which a later
   * re-bridge of that chat still reuses. Adoption runs before the flip and before
   * the room's first turn, because the ledger write it may make is
   * first-write-wins and must beat the dispatcher's own placeholder mint.
   *
   * **Idempotent on the chat, and self-healing on a torn first attempt.** When
   * the room half reports a replay (`created: false` — the chat was already
   * bridged to this binding), there is nothing to adopt (the sessionMap entry
   * was vacated the first time) and no notice to repeat. But the replay branch
   * still re-issues the binding flip before returning, because a FIRST attempt
   * can commit the room and the ledger and then have this final `bindings.update`
   * throw: the room is bridged but the binding still says `'off'`, and inbound
   * keeps routing as a private pipe. A retry then finds `created: false` and
   * would otherwise return a healthy-looking result over a still-unbridged
   * binding. Re-flipping here (idempotent — a no-op on a truly-already-bridged
   * replay) is what makes that retry actually heal.
   *
   * @param input - Which chat, which binding, which agent.
   * @returns The bridged room's id and whether an existing session was adopted.
   */
  async bridge(input: BridgeCreateInput): Promise<{ id: string; adopted: boolean }> {
    const adopter = this.deps.adopter;
    if (!adopter) {
      throw new Error('BridgeLifecycle.bridge requires a session adopter; none was wired');
    }
    const room = this.deps.rooms.createBridgedRoom({
      adapterId: input.adapterId,
      chatId: input.chatId,
      bindingId: input.bindingId,
      chatType: input.chatType,
      channelType: input.channelType,
      title: input.title,
      agentPath: input.agentPath,
      operatorAuthorId: this.deps.operatorAuthorId(),
    });
    // The bridge-create half of §8's visibility refresh (task 1.13). Runs
    // before the created/replay branch below so both paths get it — a replay
    // is idempotent here exactly like the binding flip is. Best-effort: a
    // room this call just minted must not fail to bridge because Telegram's
    // `getMe` timed out.
    await this.deps.refreshVisibility?.(input.adapterId).catch((err: unknown) => {
      logger.warn('[chat-bridge] visibility refresh at bridge-create failed', {
        adapterId: input.adapterId,
        roomId: room.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // A replay's session was migrated the first time and its history notice
    // already posted, so do not re-probe or re-notice. But DO re-issue the flip:
    // if a first attempt committed the room and ledger and then the flip below
    // threw, the binding is still `'off'` over a live bridged room, and this is
    // the retry that heals it (idempotent when it was already bridged).
    if (!room.created) {
      await this.deps.bindings.update(input.bindingId, { bridge: 'room', roomId: room.id });
      return { id: room.id, adopted: false };
    }

    // This attempt minted the room (`created === true`), and every step below —
    // resolving the seeded agent, adopting a prior session, the final flip — runs
    // AFTER the room and its bridge row are committed. A throw here therefore
    // leaves the room LIVE with the binding still `'off'`. We do NOT archive it:
    // `createBridgedRoom` refuses an archived bridge row with `CHAT_ALREADY_BRIDGED`
    // (room-service.ts), so archiving would turn the retry-heal (the replay branch
    // above) into a hard 409. Leaving it live is what lets a retry replay and
    // re-flip. The catch only makes the orphan observable, then rethrows.
    try {
      const agentAuthorId = room.members.find((m) => m.author.kind === 'agent')?.authorId;
      // A bridged room is always seeded with exactly one agent (§3.4), so a
      // missing agent member is a structural fault in the create path, not a
      // fresh-start.
      if (!agentAuthorId) {
        throw new Error(`bridged room ${room.id} has no agent member to adopt a session into`);
      }

      const { adopted } = await adopter.adoptAtBridge({
        bindingId: input.bindingId,
        chatId: input.chatId,
        agentId: input.agentId,
        roomId: room.id,
        agentAuthorId,
      });

      await this.deps.bindings.update(input.bindingId, { bridge: 'room', roomId: room.id });
      return { id: room.id, adopted };
    } catch (err) {
      // The bridge tore after minting its room: the room is live, its bridge row
      // is un-archived, and the binding is still `'off'`. A retry of `bridge()`
      // replays that surviving row and re-flips (the self-heal above), and a
      // `rebridge` of this chat reuses it — no startup reaper runs or is needed.
      logger.warn(
        '[chat-bridge] bridge() tore after minting its room; it is live but unbridged — a retry or re-bridge of this chat heals it',
        {
          adapterId: input.adapterId,
          chatId: input.chatId,
          bindingId: input.bindingId,
          roomId: room.id,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      throw err;
    }
  }

  /**
   * Switch a binding's bridge off: archive its room, record the disconnect in
   * the room's own voice, and clear `binding.bridge`/`binding.roomId` (spec
   * §3.5, rows 1–3). The bridge row and every external ref survive.
   *
   * The room half runs before the binding half so that, if archiving throws, the
   * binding is left still bridged — a state a retry can resolve — rather than a
   * binding that says `'off'` over a room that is still live.
   *
   * @param bindingId - The binding to unbridge.
   * @param opts.reason - The platform's own words, when the disconnect was forced
   *   rather than chosen (bot blocked or kicked, §10.3) — written into the room
   *   notice.
   */
  async unbridge(bindingId: string, opts: { reason?: string } = {}): Promise<void> {
    const binding = this.deps.bindings.getById(bindingId);
    // Nothing to do for a binding that is not bridged: the flag is already off,
    // or it never named a room. Idempotent on purpose — an unbridge that lost
    // its response and retried must not throw the second time.
    if (!binding || binding.bridge !== 'room' || !binding.roomId) return;
    this.deps.rooms.archiveBridgedRoom(binding.roomId, this.deps.operatorAuthorId(), opts);
    await this.deps.bindings.update(bindingId, { bridge: 'off', roomId: null });
  }

  /**
   * Re-bridge a chat that still has a surviving bridge row (spec §3.5, rows 4–5).
   * Delegates the room half to {@link BridgeRoomOps.rebridge} — reuse for the
   * same agent, adopt-and-swap for a different one — then flips the binding back
   * to `bridge: 'room'` pointing at the room the row already identifies.
   *
   * The binding half runs last, so a failure in the room half leaves the binding
   * untouched rather than pointing at a room the re-bridge never finished.
   *
   * @param request - Which chat, which binding, and which agent.
   * @returns The re-bridged room's id.
   */
  async rebridge(request: RebridgeInput): Promise<{ id: string }> {
    const room = this.deps.rooms.rebridge({
      ...request,
      operatorAuthorId: this.deps.operatorAuthorId(),
    });
    await this.deps.bindings.update(request.bindingId, { bridge: 'room', roomId: room.id });
    return room;
  }

  /**
   * The §10.9 seam: a bridged room was archived out of band, so an inbound
   * message `ingest` tried to post landed on an archived room and `RoomService`
   * threw `ROOM_ARCHIVED`. DOR-870's `ingest` catches that and calls this.
   *
   * It does what an out-of-band archive skipped: stamps the bridge row archived
   * (the room is already archived, so `archiveBridgedRoom` only touches the row),
   * clears the binding's bridge fields, and tells the chat — once — that it is no
   * longer connected. **The "once" is real under a race.** Two inbound messages
   * can both catch `ROOM_ARCHIVED` before either flip persists; both reach here.
   * The binding flip is idempotent, the row stamp is guarded on `archivedAt`, and
   * the chat notice is damped per `(binding, chat, reason)` by the sender — so
   * the second call flips nothing new and says nothing new (A10.5).
   *
   * @param binding - The bridged binding whose room turned out to be archived.
   * @param subject - The `relay.human.*` subject the inbound message arrived on,
   *   for the chat notice.
   */
  async onRoomArchivedDuringIngest(binding: LifecycleBinding, subject: string): Promise<void> {
    const roomId = binding.roomId;
    // The user-facing recovery runs FIRST, so nothing below can starve it: this
    // IS the recovery path, and stopping future ingest (the binding flip) and
    // telling the person once (the chat notice) are the two things it exists to
    // do. The bridge-row stamp that follows is internal bookkeeping — the person
    // is not waiting on it — so a throw there must not cost them the notice.
    if (binding.bridge === 'room' || binding.roomId !== null) {
      await this.deps.bindings.update(binding.id, { bridge: 'off', roomId: null });
    }
    await this.deps.chatNotice(subject, 'channel_archived', { binding: { id: binding.id } });
    // Then the bookkeeping: stamp the bridge row archived to match the room an
    // out-of-band archive left un-stamped. `archiveBridgedRoom` on an
    // already-archived room only stamps the row (it skips the notice and the
    // archive), and the stamp is guarded on `archivedAt`, so a racing second
    // call is a no-op. Left un-stamped by a throw here, the row self-heals on
    // the next `rebridge`/`archiveBridgedRoom`, and the room is already archived
    // regardless.
    if (roomId) {
      this.deps.rooms.archiveBridgedRoom(roomId, this.deps.operatorAuthorId());
    }
  }
}
