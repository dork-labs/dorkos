/**
 * The inbound half of the bridge: a platform chat message becomes a room post
 * (chats-as-channels spec §5). This is the terminal branch `BindingRouter`
 * takes for a `bridge: 'room'` binding — `ingest` writes an entry and stops. It
 * never triggers a turn: every answer-or-not decision stays in `addressing.ts`,
 * `cascade-guard.ts`, `turn-budget.ts`, and `RoomTriggerDispatcher` (§the one
 * rule).
 *
 * **What `ingest` does, in order** (spec §5.2):
 *
 * 1. **Dedup** on `{adapterId, chatId, platformMessageId}`. Telegram redelivers
 *    on webhook retry and on a polling/webhook overlap during restart, so a
 *    known message stops here — no entry, no notice, no turn.
 * 2. **Rate ceiling** per `(adapterId, chatId)`, a rolling count over
 *    {@link INGEST_RATE_WINDOW_MS}. Past {@link INGEST_RATE_CEILING} it REFUSES
 *    with one damped `bridge_rate_limited` room notice and writes nothing — it
 *    never trims, because the log is the audit trail (§9.4) and dropping the
 *    oldest entry would corrupt the record the ceiling protects.
 * 3. **Resolve the room** from the bridge row. A missing or archived row is a
 *    broken bridge: the person is told in-chat and NO room is created — a bridge
 *    whose room was archived out of band must not resurrect itself.
 * 4. **Resolve or mint the external author** (§4.1), joining them to the roster
 *    on their first message (§4.2).
 * 5. **Write the entry** through `RoomService.postExternal`.
 * 6. **Record the inbound external ref** in the SAME transaction as step 5, so a
 *    crash leaves both rows or neither (A5.6).
 *
 * **Serialization** (§5.3): `ingest` is serialized per `(adapterId, chatId)` by
 * an in-process promise chain, so two updates cannot interleave their
 * transactions and the room log's `seq` is the order the bridge ACCEPTED
 * messages — never the platform's clock. This serializes a few indexed writes,
 * never a turn.
 *
 * @module server/services/relay/chat-bridge/ingest
 */
import { z } from 'zod';
import type { DbTransaction } from '@dorkos/db';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type { ChatNoticeSender, SubscriberVerdict } from '@dorkos/relay';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../../rooms/room-errors.js';
import { buildBridgeRateLimitedNotice } from '../../rooms/notices/notice-copy.js';
import type { ExternalAuthorIdentity } from '../../rooms/author-registry.js';
import { parseHumanSubject } from '../human-subject.js';
import { externalSenderIdentity } from '../platform-identity.js';
import type { BridgeStore } from './bridge-store.js';
import type { LifecycleBinding } from './lifecycle.js';

/**
 * Accepted inbound messages per chat before `ingest` refuses, counted over
 * {@link INGEST_RATE_WINDOW_MS} (chats-as-channels spec §5.2 step 2).
 *
 * **The spec fixes the shape, not the number** — a rolling per-chat ceiling that
 * refuses rather than trims. This starting value (60 accepted messages per chat
 * per 60s) is one deliberately-named constant so tuning it is a one-line edit,
 * and it is generous on purpose: the bound agent is already protected by the
 * turn budget's two ceilings, so this exists to bound the LOG and the disk
 * against a chat firing faster than any human conversation, not to throttle an
 * ordinary one. The busiest realistic case is a bridged DM (§14).
 */
export const INGEST_RATE_CEILING = 60;

/** The rolling window {@link INGEST_RATE_CEILING} is counted over. */
export const INGEST_RATE_WINDOW_MS = 60_000;

/**
 * How long a `bridge_rate_limited` room notice stays quiet in one room after it
 * fires — so a sustained burst produces one line, not one per refused message
 * (A5.9). Matches the chat-notice damper (`chat-notice.ts`).
 */
const RATE_NOTICE_DAMP_MS = 10 * 60_000;

/** Why an inbound message was not written. Each maps to a distinct refusal. */
export type IngestRefusalReason =
  | 'missing_message_id'
  | 'duplicate_inbound'
  | 'broken_bridge'
  | 'bridge_rate_limited'
  | 'no_author'
  | 'room_archived';

/**
 * The outcome of one `ingest`, told in a shape `BindingRouter` can close a
 * dispatch on: `ingested` wrote an entry (its `seq` allocated in acceptance
 * order), `refused` declined and carries the {@link SubscriberVerdict} the relay
 * subscription reports.
 */
export type IngestResult =
  | { status: 'ingested'; entryId: string; joined: boolean }
  | { status: 'refused'; reason: IngestRefusalReason; verdict: SubscriberVerdict };

/**
 * The room-domain writes `ingest` performs, as a structural interface rather
 * than an import of `RoomService` — the rooms domain already imports this
 * package's {@link BridgeStore}, and importing its service back would close a
 * cycle (the same reasoning `lifecycle.ts` records). `RoomService` satisfies
 * this by shape.
 */
export interface IngestRoomOps {
  /**
   * Write a message from outside this machine, minting the author and joining
   * them to the roster on their first message, all atomic with the entry —
   * {@link RoomService.postExternal}.
   */
  postExternal(
    roomId: string,
    input: {
      identity: ExternalAuthorIdentity;
      text: string;
      mentionAugment?: { agentPath: string; names: readonly string[] };
      recordRef?: (entryId: string, tx: DbTransaction) => void;
    }
  ): { entry: { id: string }; joined: boolean };
  /** Write the room's own voice — {@link RoomService.postNotice}. */
  postNotice(roomId: string, body: RoomEntryBody): { id: string };
}

/**
 * The §10.9 recovery seam: an inbound message landed on a room archived out of
 * band. {@link BridgeLifecycle.onRoomArchivedDuringIngest} satisfies this.
 */
export interface IngestLifecycle {
  onRoomArchivedDuringIngest(binding: LifecycleBinding, subject: string): Promise<void>;
}

/** Everything {@link ChatBridge} is constructed from. */
export interface ChatBridgeDeps {
  /** The room-domain writes — the real `RoomService` in production. */
  rooms: IngestRoomOps;
  /** The bridge identity and external-ref store (spec §3.1, §6.3). */
  bridges: BridgeStore;
  /** The lifecycle coordinator, for the archived-out-of-band recovery (§10.9). */
  lifecycle: IngestLifecycle;
  /**
   * Tell the person in the chat, once (damped per `(binding, chat, reason)`),
   * that a broken bridge could not take their message (§5.8).
   */
  chatNotice: ChatNoticeSender;
  /** Clock, injectable so the rate window and its damper are testable. */
  now?: () => number;
}

/**
 * What {@link ChatBridge.ingest} needs beyond the binding and envelope: the
 * bound agent's project directory, so `@botusername` can be threaded as one
 * extra addressing candidate for it (spec §5.4). `BindingRouter` already
 * resolved it for the agent-in-mesh check, so it is passed rather than
 * re-derived.
 */
export interface IngestContext {
  /** The bound agent's project directory — its author's natural key. */
  agentPath: string;
}

/** The inbound seam `BindingRouter` calls for a `bridge: 'room'` binding. */
export interface ChatBridgeIngest {
  ingest(
    binding: LifecycleBinding,
    envelope: RelayEnvelope,
    ctx: IngestContext
  ): Promise<IngestResult>;
}

/**
 * The ingest-relevant fields of an inbound payload, parsed rather than cast:
 * `platformData` is `z.unknown()` in the envelope schema. Everything here is
 * additive (spec §11.2) and optional, and numeric ids (Telegram's are numbers)
 * are coerced to their string form.
 */
/**
 * A media descriptor as `ingest` reads it — deliberately LOOSER than
 * `TelegramMediaDescriptorSchema`'s closed `type` enum. `type` is a plain string
 * so a descriptor from a newer adapter carrying a media kind this phase does not
 * model yet (a future `gif`, say) still parses, and {@link mediaPlaceholder}'s
 * `[attachment]` fallback catches it. Coupled with the `.catch(undefined)` below,
 * this is what keeps media-schema drift from dropping an otherwise valid message
 * (§5.5): a bad or unknown descriptor degrades to a placeholder, it never fails
 * the whole payload parse and loses the `messageId` with it.
 */
const IngestMediaSchema = z.object({
  type: z.string().min(1),
  durationSec: z.number().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

/** A media descriptor as {@link mediaPlaceholder} needs it — loose on `type`. */
type IngestMedia = z.infer<typeof IngestMediaSchema>;

const IngestPayloadSchema = z.object({
  content: z.string().optional(),
  platformData: z
    .object({
      messageId: z.union([z.string().min(1), z.number()]).optional(),
      messageThreadId: z.union([z.string().min(1), z.number()]).optional(),
      threadName: z.string().optional(),
      // Field-scoped `.catch(undefined)`: a media descriptor that fails to parse
      // (a non-object, or a shape a newer adapter changed) degrades to no media
      // rather than failing the whole payload — the message still ingests with
      // its `messageId` intact (§5.5). Unknown-but-well-formed kinds parse fine
      // through the loose `type` above and render as `[attachment]`.
      media: IngestMediaSchema.optional().catch(undefined),
      /** The bound bot's own `@`-handle, from `getMe().username` (spec §5.4). */
      botUsername: z.string().min(1).optional(),
    })
    .partial()
    .optional(),
});

/** The fields `ingest` reads off one inbound envelope, already narrowed. */
interface IngestPayload {
  content: string;
  platformMessageId: string | undefined;
  threadId: string | undefined;
  threadName: string | undefined;
  media: IngestMedia | undefined;
  botUsername: string | undefined;
}

/** Coerce a maybe-numeric id to its non-empty string form, or `undefined`. */
function asId(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const str = String(value);
  return str.length > 0 ? str : undefined;
}

/** Read the ingest-relevant fields off an inbound envelope payload. */
function readPayload(payload: unknown): IngestPayload {
  const parsed = IngestPayloadSchema.safeParse(payload);
  const data = parsed.success ? parsed.data : {};
  const platformData = data.platformData ?? {};
  return {
    content: data.content ?? '',
    platformMessageId: asId(platformData.messageId),
    threadId: asId(platformData.messageThreadId),
    threadName: platformData.threadName,
    media: platformData.media,
    botUsername: platformData.botUsername,
  };
}

/** `14 → '0:14'`, `75 → '1:15'` — a media placeholder's duration (spec §5.5). */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/**
 * The server-authored placeholder for a non-text message (spec §5.5), built
 * from the structured media descriptor — never from adapter-authored prose. The
 * placeholder renders inside the untrusted fence like any other message body, so
 * the file name it carries needs no sanitization here (§9.2).
 *
 * @param media - The descriptor the adapter put on `platformData.media`.
 */
function mediaPlaceholder(media: IngestMedia): string {
  const named = (label: string): string =>
    media.fileName ? `[${label}: ${media.fileName}]` : `[${label}]`;
  const timed = (label: string): string =>
    media.durationSec !== undefined
      ? `[${label}, ${formatDuration(media.durationSec)}]`
      : `[${label}]`;
  switch (media.type) {
    case 'photo':
      return '[photo]';
    case 'sticker':
      return '[sticker]';
    case 'voice':
      return timed('voice message');
    case 'video_note':
      return timed('video message');
    case 'audio':
      return named('audio');
    case 'video':
      return named('video');
    case 'document':
      return named('document');
    case 'location':
      return '[location]';
    default:
      // Every descriptor type above returns; a value outside the closed set is a
      // future media kind this phase does not model yet. A generic placeholder
      // keeps the log honest ("something non-text arrived") rather than throwing.
      return '[attachment]';
  }
}

/**
 * The entry body a message writes: a media placeholder plus any caption, or the
 * plain text (spec §5.5). The caption is `content` — the adapter sets
 * `content` to the caption for captioned media and `''` for captionless — and it
 * lands in the same untrusted region as any other message text.
 *
 * @param payload - The narrowed inbound payload.
 */
function buildEntryText(payload: IngestPayload): string {
  if (payload.media) {
    const placeholder = mediaPlaceholder(payload.media);
    return payload.content ? `${placeholder}\n${payload.content}` : placeholder;
  }
  return payload.content;
}

/** The in-process serialization key for one platform chat. */
function serialKey(adapterId: string, chatId: string): string {
  return `${adapterId} ${chatId}`;
}

/**
 * The inbound bridge (chats-as-channels spec §5). One instance per server; it
 * holds the per-chat serialization chains and the rate windows.
 */
export class ChatBridge implements ChatBridgeIngest {
  private readonly deps: ChatBridgeDeps;
  private readonly now: () => number;
  /** Per-`(adapterId, chatId)` serialization tail (spec §5.3). */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per-`(adapterId, chatId)` acceptance timestamps in the rolling window. */
  private readonly rateWindows = new Map<string, number[]>();
  /** Per-room last time a `bridge_rate_limited` notice was written. */
  private readonly rateNoticedAt = new Map<string, number>();

  constructor(deps: ChatBridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Ingest one inbound message, serialized behind every other inbound for the
   * same `(adapterId, chatId)` (spec §5.3). The returned promise settles with
   * this message's own outcome; the chain it joins keeps running whether this
   * one resolved or threw, so one bad message never wedges a chat.
   *
   * @param binding - The bridged binding the message resolved to.
   * @param envelope - The inbound `relay.human.*` envelope.
   * @param ctx - The bound agent's project directory (spec §5.4).
   */
  ingest(
    binding: LifecycleBinding,
    envelope: RelayEnvelope,
    ctx: IngestContext
  ): Promise<IngestResult> {
    const chatId = binding.chatId ?? parseHumanSubject(envelope.subject).chatId ?? '';
    const key = serialKey(binding.adapterId, chatId);
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(() => this.ingestSerial(binding, envelope, ctx));
    // The tail swallows the result so a thrown or refused message does not break
    // the chain the NEXT message waits on; the caller still gets `run` with the
    // real outcome. Cleaned up when this is the last link, so an idle chat leaves
    // no entry behind.
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** One message's ingest, already serialized for its chat. */
  private async ingestSerial(
    binding: LifecycleBinding,
    envelope: RelayEnvelope,
    ctx: IngestContext
  ): Promise<IngestResult> {
    const { platformType } = parseHumanSubject(envelope.subject);
    const adapterId = binding.adapterId;
    const chatId = binding.chatId ?? parseHumanSubject(envelope.subject).chatId;
    if (!chatId) {
      return this.refuse('broken_bridge', 'a bridged binding carried no chat id');
    }

    const payload = readPayload(envelope.payload);

    // Every real message carries a platform id; its absence is a malformed or
    // synthetic payload, and without it there is nothing to dedup on.
    const platformMessageId = payload.platformMessageId;
    if (!platformMessageId) {
      return this.refuse('missing_message_id', 'an inbound bridged message had no platform id');
    }

    // 1. Dedup (§5.2 step 1). Inside the serialized section, so two copies of one
    // redelivered message — the second waiting on the first — see the ref the
    // first wrote and stop, rather than racing the unique index.
    if (this.deps.bridges.findInboundRefByPlatformMessage(adapterId, chatId, platformMessageId)) {
      logger.debug('[chat-bridge] dropped a duplicate inbound message', {
        adapterId,
        chatId,
        platformMessageId,
      });
      return this.refuse('duplicate_inbound', 'already ingested this platform message');
    }

    // 3. Resolve the room from the bridge row (§5.2 step 3). A missing or
    // archived row — or a binding that names no room — is a broken bridge: tell
    // the chat, create nothing. Done before the rate check so the rate notice
    // has a live room to land in.
    const bridge = this.deps.bridges.findBridgeByChat(adapterId, chatId);
    if (!bridge || bridge.archivedAt !== null || !binding.roomId) {
      await this.tellChat(envelope.subject, binding.id);
      return this.refuse('broken_bridge', 'a bridged binding has no live room');
    }
    const roomId = bridge.roomId;

    // 2. Rate ceiling (§5.2 step 2). Refuse, never trim.
    if (this.overCeiling(adapterId, chatId)) {
      this.postRateNotice(roomId);
      return this.refuse('bridge_rate_limited', 'per-chat ingest ceiling reached');
    }

    // 4. Resolve the external author (§4.1). No resolvable platform user id → no
    // author, and the message is dropped rather than folded into a shared
    // "someone" that would merge two strangers in a log meant to be evidence.
    const identity = externalSenderIdentity(envelope.payload, {
      platformType: platformType ?? 'unknown',
      instanceId: adapterId,
    });
    if (!identity) {
      return this.refuse('no_author', 'inbound message carries no platform user id');
    }

    // 5 + 6. Write the entry and its inbound ref in one transaction (§5.2, A5.6).
    const text = buildEntryText(payload);
    // A forum topic's id targets outbound delivery (§6.5); its name is a LABEL
    // rendered outside the fence, so it is sanitized here, at the store, not only
    // at render (§9.2, A9.3).
    const threadName =
      payload.threadName !== undefined
        ? (sanitizeIdentity(payload.threadName) ?? undefined)
        : undefined;
    const createdAt = new Date(this.now()).toISOString();
    // The one platform translation (§5.4): `@botusername` → the bound agent, as
    // an extra addressing candidate appended after the agent's own handles.
    // `ingest` rewrites nothing; the log holds exactly what the person typed.
    const mentionAugment = payload.botUsername
      ? { agentPath: ctx.agentPath, names: [payload.botUsername] }
      : undefined;

    try {
      const { entry, joined } = this.deps.rooms.postExternal(roomId, {
        identity,
        text,
        mentionAugment,
        recordRef: (entryId, tx) =>
          this.deps.bridges.recordInboundRef(
            {
              roomId,
              entryId,
              chatId,
              adapterId,
              platformMessageId,
              threadId: payload.threadId,
              threadName,
              createdAt,
            },
            tx
          ),
      });
      // Only an ACCEPTED message counts against the ceiling, and only after it
      // is written — a duplicate or a refusal never does. Safe without a lock:
      // this whole method is serialized per chat.
      this.recordAccepted(adapterId, chatId);
      // The room just accepted a message, so it is not flooding now: forget a
      // rate-limit stamp older than the damp window rather than letting it linger
      // for the process lifetime (bounds `rateNoticedAt` at the many-rooms scale).
      const noticedAt = this.rateNoticedAt.get(roomId);
      if (noticedAt !== undefined && this.now() - noticedAt >= RATE_NOTICE_DAMP_MS) {
        this.rateNoticedAt.delete(roomId);
      }
      // A live bridge is an active chat, so proactive notices still find it
      // after `sessionMap` is vacated (§7.5).
      this.deps.bridges.stampActivity(roomId, createdAt);
      return { status: 'ingested', entryId: entry.id, joined };
    } catch (err) {
      // The room was archived out from under a live bridge (§10.9): switch the
      // bridge off and tell the chat once. `onRoomArchivedDuringIngest` is
      // idempotent and damped, so two racing messages resolve to one flip and
      // one notice (A10.5).
      if (err instanceof RoomError && err.code === 'ROOM_ARCHIVED') {
        await this.deps.lifecycle.onRoomArchivedDuringIngest(binding, envelope.subject);
        return this.refuse('room_archived', 'bridged room was archived out of band');
      }
      // The room is gone, or its bridge row was archived between the resolve
      // above and this write — a broken bridge, told once, creating nothing.
      if (
        err instanceof RoomError &&
        (err.code === 'ROOM_NOT_FOUND' || err.code === 'NOT_A_BRIDGED_ROOM')
      ) {
        await this.tellChat(envelope.subject, binding.id);
        return this.refuse('broken_bridge', 'bridged room is missing');
      }
      throw err;
    }
  }

  /** Build a `refused` outcome carrying the verdict the relay reports. */
  private refuse(reason: IngestRefusalReason, why: string): IngestResult {
    return { status: 'refused', reason, verdict: { handled: false, reason: why } };
  }

  /** Tell the chat, once, that a broken bridge could not take the message (§5.8). */
  private async tellChat(subject: string, bindingId: string): Promise<void> {
    // Best-effort and damped by the sender per `(binding, chat, reason)`; a
    // notice that cannot be delivered must not take down the ingest path.
    try {
      await this.deps.chatNotice(subject, 'channel_archived', { binding: { id: bindingId } });
    } catch (err) {
      logger.warn('[chat-bridge] could not tell a chat its bridge is broken', {
        subject,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether this chat is at or past its rolling ingest ceiling (§5.2 step 2).
   * Prunes the window to {@link INGEST_RATE_WINDOW_MS} before counting.
   *
   * **Evict-when-empty, so the map cannot grow unbounded across many chats.** A
   * chat whose window has fully aged out drops its key entirely rather than
   * holding an empty array for the process lifetime — the one bound this needs at
   * the many-chats scale, and no more than that (no LRU, no sweep). A chat that
   * keeps sending re-creates its key on {@link recordAccepted}; a chat that goes
   * quiet leaves nothing behind the next time it is looked at.
   */
  private overCeiling(adapterId: string, chatId: string): boolean {
    const key = serialKey(adapterId, chatId);
    const cutoff = this.now() - INGEST_RATE_WINDOW_MS;
    const window = (this.rateWindows.get(key) ?? []).filter((at) => at > cutoff);
    if (window.length === 0) {
      this.rateWindows.delete(key);
    } else {
      this.rateWindows.set(key, window);
    }
    return window.length >= INGEST_RATE_CEILING;
  }

  /** Record one accepted message against this chat's rolling window. */
  private recordAccepted(adapterId: string, chatId: string): void {
    const key = serialKey(adapterId, chatId);
    const window = this.rateWindows.get(key) ?? [];
    window.push(this.now());
    this.rateWindows.set(key, window);
  }

  /**
   * Write one `bridge_rate_limited` room notice, damped per room so a sustained
   * burst produces one line rather than one per refused message (A5.9).
   */
  private postRateNotice(roomId: string): void {
    const at = this.now();
    const last = this.rateNoticedAt.get(roomId);
    if (last !== undefined && at - last < RATE_NOTICE_DAMP_MS) return;
    this.rateNoticedAt.set(roomId, at);
    try {
      this.deps.rooms.postNotice(roomId, buildBridgeRateLimitedNotice());
    } catch (err) {
      // The room could have been archived out of band; a notice that cannot land
      // must not turn a refusal into a throw. Forget the stamp so the next burst
      // gets a chance to speak once the room is live again.
      this.rateNoticedAt.delete(roomId);
      logger.warn('[chat-bridge] could not write a rate-limit notice', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
