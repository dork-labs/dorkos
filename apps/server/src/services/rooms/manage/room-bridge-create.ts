/**
 * Opening the room half of a bridge — the create path for a claimed platform
 * chat (chats-as-channels spec §3.1–§3.4).
 *
 * Deliberately its own path rather than a flag on the ordinary create: a
 * bridged private chat's roster is byte-identical to the operator's own DM
 * with the same agent, and the DM branch of `createRoom` would hand that
 * private conversation back — with a stranger's messages landing in it.
 *
 * @module server/services/rooms/manage/room-bridge-create
 */
import { ulid } from 'ulidx';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import {
  ChannelTypeSchema,
  type ChannelType,
  type PlatformChatType,
} from '@dorkos/shared/relay-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type {
  BridgeStore,
  BridgeablePlatformChatType,
} from '../../relay/chat-bridge/bridge-store.js';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomProjection } from '../service/room-projection.js';
import type { RoomRoster } from '../room-roster.js';
import type { NewRoom } from '../room-rows.js';
import { slugify, uniqueChannelSlug } from '../service/room-slugs.js';
import type { OpenedRoom } from '../service/room-service-deps.js';
import type { RoomStore } from '../room-store.js';

/**
 * Input to {@link RoomService.createBridgedRoom} — already resolved and
 * validated by the caller (chats-as-channels spec §3.1's claim card / "Bridge
 * to a channel" entry points, both one code path). Every platform-sourced
 * field crosses the trust boundary at this call.
 */
export interface CreateBridgedRoomRequest {
  /** The relay adapter instance this chat lives on. */
  adapterId: string;
  /** The platform chat id, scoped to `adapterId`. */
  chatId: string;
  /** The binding this bridge is a mode of. */
  bindingId: string;
  /**
   * Read from `platformData.chatType`, never re-derived (spec §3.3). The full
   * raw {@link PlatformChatType}: `'channel'` — a Telegram broadcast — is
   * accepted at the boundary and refused inside
   * {@link RoomService.createBridgedRoom}, so the refusal lives at the one trust
   * boundary rather than being pushed onto every caller's type.
   */
  chatType: PlatformChatType;
  /**
   * `ChannelTypeSchema` value read off the relay subject, or `null` for a DM
   * subject. Typed loosely at the boundary (`string | null`) and parsed
   * through `ChannelTypeSchema.nullable()` at the top of
   * {@link RoomService.createBridgedRoom} — the same trust-boundary reasoning
   * as `chatType` above applies to this field too.
   */
  channelType: string | null;
  /**
   * The raw, UNSANITIZED platform title: the external person's display name
   * for a `dm`, the platform chat title for a `channel`. Sanitized inside
   * {@link RoomService.createBridgedRoom} (spec §9.2, A9.3) — never sanitize it
   * twice, and never pass an already-sanitized value.
   */
  title: string;
  /** The bound agent's directory. Exactly one agent seeds a bridged room (D-6 Q3). */
  agentPath: string;
  /** The operator's author id. The bridge always creates the room AS the operator (spec §3.4). */
  operatorAuthorId: string;
}

/** The room half of bridging a platform chat for the first time. */
export class RoomBridgeCreation {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(
    core: RoomCore,
    private readonly projection: RoomProjection
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.isOwnerAuthor = core.isOwnerAuthor;
  }

  /**
   * Open a room for a claimed platform chat (chats-as-channels spec §3.1–§3.4)
   * — the room half of the bridge create path.
   *
   * **Never idempotent on member set — the whole reason this method exists
   * rather than a `kind: 'dm'` call to {@link RoomService.createRoom}.** A
   * bridged private chat's roster (the bound agent plus the operator) is
   * byte-identical to the operator's own private DM with that agent, and
   * `createRoom`'s DM branch would silently return — and un-archive — that
   * private conversation, landing a stranger's messages in it (spec §3.2, D-7
   * amendment 1). This method never calls {@link RoomStore.findDmByMemberSet}
   * at all, in either kind branch: that is the bypass the spec requires, and
   * it holds by construction rather than by a flag threaded through the shared
   * path.
   *
   * **Idempotent on the chat — resolved through the bridge store, never the
   * roster (spec §3.2, A3.2).** After the chat-type validation below, the
   * next thing this method does is {@link BridgeStore.findBridgeByChat}. A
   * live bridge already pointing at the SAME binding is the plain-replay
   * case — bridging a chat that is already bridged the way it is already
   * bridged — and this method self-heals it by returning that room rather
   * than minting a second one beside it. Anything else an existing row could
   * mean — a different binding (which usually, but not always, means a
   * different agent: a binding can also be re-created for the SAME agent),
   * or an archived row (un-archive and reuse) — is §3.5's re-bridge
   * lifecycle, which is task 1.5's, not this create path's: this method
   * refuses those with `CHAT_ALREADY_BRIDGED` rather than guessing at rebind
   * semantics it does not implement. The `UNIQUE (adapter_id, chat_id)`
   * index is the structural backstop either way.
   *
   * **Kind mapping (§3.3).** `private` → `dm`; `group` / `supergroup` →
   * `channel`; `channel` (a Telegram broadcast) is refused — a broadcast is
   * not a conversation.
   *
   * **Roster (§3.4).** Exactly the bound agent and the operator, both written
   * in the SAME transaction as the room and the `room_bridges` row. A bridged
   * `channel`'s agent joins `mention-only`, resolved directly into its
   * membership row here — never as a follow-up `setResponseMode` — because
   * `RoomRoster.seedResponseMode` returns `engaged` for a channel, and there
   * must be no observable instant where a bridged group's agent is anything
   * but mention-gated (D-7 amendment 1's "no observable instant" invariant,
   * §3.4's implementation 1). A bridged `dm`'s agent keeps the manifest
   * default, same as any other DM. The operator is not re-checked against
   * `requireSeedingAllowed`: the bridge always creates as the operator, which
   * is what satisfies that gate without an exemption (§3.4).
   *
   * **Title and slug (§3.4, §9.2, A9.3).** `request.title` is untrusted
   * platform text and is sanitized HERE, at creation, not only at render —
   * `sanitizeIdentity`, the one function, never a second copy. A `channel`
   * slug that collides with a live channel gets `-2`, `-3`, … appended until
   * free (A3.4): a platform title is not something the person bridging typed
   * and gets to fix, so this never throws `SLUG_TAKEN` the way
   * {@link RoomService.createRoom} does.
   *
   * @param request - Every input the create path needs, already resolved by
   *   the caller (the claim flow / "Bridge to a channel" action).
   * @returns The new bridged room with its roster.
   */
  createBridgedRoom(request: CreateBridgedRoomRequest): OpenedRoom {
    // `request.chatType` is typed as the closed `PlatformChatType` union, but
    // that type is a claim about the CALLER's discipline, not a runtime
    // guarantee: the value crosses a trust boundary from Telegram's
    // own string (`chat.type`, `packages/relay/src/adapters/telegram/
    // inbound.ts:470`) through several untyped hops before it reaches here.
    // This switch is exhaustive and refuses anything it does not recognize,
    // rather than letting an unrecognized string fall through the
    // kind-mapping ternary below and get silently treated as `channel`.
    let platformChatType: BridgeablePlatformChatType;
    switch (request.chatType) {
      case 'private':
      case 'group':
      case 'supergroup':
        platformChatType = request.chatType;
        break;
      case 'channel':
        throw new RoomError(
          'BROADCAST_NOT_BRIDGEABLE',
          'A broadcast channel is not a conversation and cannot be bridged'
        );
      default: {
        const unrecognized: string = request.chatType;
        throw new RoomError(
          'UNKNOWN_CHAT_TYPE',
          `Unrecognized platform chat type '${unrecognized}' — cannot bridge`
        );
      }
    }

    // Same trust-boundary reasoning as `chatType` above: `channelType` is
    // typed loosely (`string | null`) at the request boundary and parsed
    // through the real schema here, as the field's own doc claims — not
    // just declared and trusted.
    const channelTypeResult = ChannelTypeSchema.nullable().safeParse(request.channelType);
    if (!channelTypeResult.success) {
      throw new RoomError(
        'UNKNOWN_CHAT_TYPE',
        `Unrecognized channel type '${String(request.channelType)}' — cannot bridge`
      );
    }
    const channelType: ChannelType | null = channelTypeResult.data;

    // Checked BEFORE the idempotent-replay short-circuit below, not just on
    // the create branch — a non-owner caller gets the same 403 whether or not
    // the chat it named is already bridged, the same "refuse before probing"
    // shape `createRoom`'s own seeding gate takes. That guarantee holds
    // relative to the BRIDGE LOOKUP below only — it says nothing about the
    // chat-type validation above, which runs first and refuses an
    // unrecognized or broadcast `chatType` before the operator is even
    // resolved. That ordering is harmless: a chat type is not information a
    // non-owner caller learns anything sensitive from.
    const operator = this.roster.requireAuthor(request.operatorAuthorId);
    if (!this.isOwnerAuthor(operator.id)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can bridge a chat');
    }

    const existingBridge = this.bridges.findBridgeByChat(request.adapterId, request.chatId);
    if (existingBridge) {
      if (existingBridge.archivedAt !== null || existingBridge.bindingId !== request.bindingId) {
        throw new RoomError(
          'CHAT_ALREADY_BRIDGED',
          'This chat is already bridged; re-bridging it needs the rebind flow, not a fresh create'
        );
      }
      const room = this.store.getRoom(existingBridge.roomId);
      if (!room) {
        // Structurally impossible on this single connection — `room_bridges.
        // room_id` has no FK cascade path that outlives its room — but a
        // defensive read-back beats a null-pointer crash if it ever happens.
        throw new RoomError('ROOM_NOT_FOUND', 'The bridged room no longer exists');
      }
      // The binding matched, which is what makes this a replay rather than a
      // rebind — but the caller's BELIEF about which agent that binding
      // points at might still be stale or wrong. Surface the mismatch rather
      // than silently handing back a room bound to a different agent than the
      // caller thinks it bridged; still return the existing room either way,
      // since the binding identity — not the caller's `agentPath` — is what
      // this method treats as ground truth.
      const currentAgent = this.roster
        .list(room.id)
        .map((member) => this.authors.getById(member.authorId))
        .find((author): author is AuthorRecord => author?.kind === 'agent');
      if (currentAgent && currentAgent.naturalKey !== request.agentPath) {
        logger.warn(
          '[rooms] a bridge replay named a different agent than the room actually holds',
          {
            roomId: room.id,
            bindingId: request.bindingId,
            requestedAgentPath: request.agentPath,
            actualAgentPath: currentAgent.naturalKey,
          }
        );
      }
      return { ...this.projection.withRoster(room, operator.id), created: false };
    }

    const kind: RoomKind = platformChatType === 'private' ? 'dm' : 'channel';

    const agent = this.roster.resolve({ agentPath: request.agentPath });

    const title = sanitizeIdentity(request.title) ?? this.fallbackBridgeTitle(kind);
    const slug =
      kind === 'channel' ? uniqueChannelSlug(this.store, slugify(title) ?? 'chat') : null;

    const createdAt = new Date().toISOString();
    const draft: NewRoom = {
      id: ulid(),
      kind,
      slug,
      title,
      topic: null,
      // The create-path bypass of §3.2, now also structural in the DATABASE
      // (DOR-1616). This flag is what keeps a bridged private chat out of
      // `rooms_dm_member_key_unique`: its roster is byte-identical to the
      // operator's own DM with the same agent, so a bridged chat inside that
      // constraint would either collide with the private conversation or be
      // handed back as it. Not calling `findDmByMemberSet` is no longer the only
      // thing standing between the two.
      bridged: true,
      createdAt,
    };
    // The one place this seeds a responseMode that is NOT
    // `RoomRoster.seedResponseMode`'s own answer — mention-only for a bridged
    // channel is a create-time override, resolved atomically with the add
    // (§3.4's implementation 1), not a value that channel's default would have
    // produced (`engaged`) and that a later write would have to correct.
    const agentResponseMode: ResponseMode =
      kind === 'channel' ? 'mention-only' : this.roster.seedResponseMode(draft, agent);
    const members = [
      {
        authorId: operator.id,
        responseMode: this.roster.seedResponseMode(draft, operator),
        joinedAt: createdAt,
      },
      { authorId: agent.id, responseMode: agentResponseMode, joinedAt: createdAt },
    ];

    const room = this.store.createRoom(draft, members, (tx) => {
      this.bridges.createBridge(
        {
          roomId: draft.id,
          adapterId: request.adapterId,
          chatId: request.chatId,
          channelType,
          platformChatType,
          bindingId: request.bindingId,
          // The SAME sanitized value that just named the room, never a second
          // copy — `null` for a DM, whose title is the person's display name
          // rather than a platform-side chat title (spec §3.4). This is what
          // lets the room sheet show what the chat is *actually* called on
          // the platform even after the room itself has been renamed, since a
          // rename never touches this column.
          platformTitle: kind === 'channel' ? title : null,
          // D-6 Q5: seeded by room kind — true for a bridged dm, false for a
          // bridged channel. The one per-bridge override lives on the row
          // itself; this create path never flips it later.
          deliverNotices: kind === 'dm',
          createdAt,
        },
        tx
      );
    });

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { ...this.projection.withRoster(room, operator.id), created: true };
  }

  /**
   * The title a bridged room falls back to when its platform-sourced title
   * sanitizes to nothing — an empty or symbol-only chat title is not
   * impossible (spec §9.2).
   *
   * @param kind - The room kind, for wording.
   */
  fallbackBridgeTitle(kind: RoomKind): string {
    return kind === 'dm' ? 'Bridged chat' : 'Bridged channel';
  }
}
