/**
 * Who wrote an inbound chat message, read off the payload the adapters build.
 *
 * There is **one** parser for this, and that is the whole point of the module.
 * Three consumers now ask the same question — the `per-user` session strategy,
 * the unclaimed-chat claim feed, and a bridged room's external author
 * (chats-as-channels spec §4.1) — and the third one keys a DURABLE identity on
 * the answer. A second reader that disagreed with the first by a coercion rule
 * would mint a second author for the same person, or worse, merge two people
 * into one row in a log that is meant to be evidence.
 *
 * Everything here reads identity and display fields only. The message body is
 * never touched: the claim feed must not show a stranger's text, and an author
 * is not derived from what somebody said.
 *
 * @module services/relay/platform-identity
 */
import { z } from 'zod';
import { PlatformChatTypeSchema, type PlatformChatType } from '@dorkos/shared/relay-schemas';
import type { ExternalAuthorIdentity } from '../rooms/author-registry.js';

/**
 * The RAW platform chat type an inbound payload carries on
 * `platformData.chatType` — Telegram's `chat.type`. Parsed, not cast, since
 * `platformData` is `z.unknown()` on the envelope; anything outside the known
 * set (or an adapter that carries none, like Slack) reads as `undefined`.
 */
const PlatformChatTypeCarrierSchema = z
  .object({ chatType: PlatformChatTypeSchema.optional() })
  .partial();

/**
 * The identity fields an inbound chat payload carries for the person who wrote
 * the message. Slack writes `userId`; Telegram writes `fromId`.
 *
 * Read out of `payload.platformData`, which is `z.unknown()` in the envelope
 * schema, so it is parsed rather than cast. Numeric ids (Telegram's are
 * numbers) are coerced to their string form; anything else is treated as
 * absent.
 */
const PlatformIdentitySchema = z
  .object({
    /** Slack's author id (`U…`). */
    userId: z.union([z.string().min(1), z.number()]).optional(),
    /** Telegram's author id (`from.id`). */
    fromId: z.union([z.string().min(1), z.number()]).optional(),
  })
  .partial();

/**
 * The sender's display name, a TOP-LEVEL `StandardPayload` field every adapter
 * sets (`packages/relay/src/adapters/{telegram,slack}/inbound.ts`), sourced
 * from the platform's own profile name and already computed for the message's
 * routing metadata.
 *
 * RAW — whatever the person typed into their profile, angle brackets and all.
 * Every consumer sanitizes: the author registry at mint,
 * `room-context-block.ts` at render.
 */
const SenderNameSchema = z.object({ senderName: z.string().min(1).optional() }).partial();

/**
 * The stable per-person key inside one chat, or `undefined` when the message
 * carries none.
 *
 * The `per-user` session strategy used to read `envelope.metadata?.userId` — a
 * field `RelayEnvelope` does not have — so it always resolved to the chat
 * id and was byte-identical to `per-chat`. In a group chat that put everyone's
 * conversation in one session: whatever one person said, the next person's turn
 * could read. The real id has always been in the payload the adapters build
 * (`platformData.userId` on Slack, `platformData.fromId` on Telegram); this
 * reads it from there.
 *
 * @param payload - The relay envelope payload as it arrived.
 * @returns The platform user id as a string, or `undefined`.
 */
export function extractPlatformUserId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const platformData = (payload as { platformData?: unknown }).platformData;
  const parsed = PlatformIdentitySchema.safeParse(platformData);
  if (!parsed.success) return undefined;
  const raw = parsed.data.userId ?? parsed.data.fromId;
  if (raw === undefined) return undefined;
  const asString = String(raw);
  return asString.length > 0 ? asString : undefined;
}

/**
 * The RAW platform chat type this message arrived from
 * (`platformData.chatType`), or `undefined` when the payload carries none or an
 * unrecognized value. Kept distinct from the subject-level channel type so a
 * broadcast `channel` survives to the claim feed and, through it, to a binding
 * — which is what lets the bridge action tell a group from a broadcast
 * (DOR-907). Reading an unknown value as `undefined` (rather than passing it
 * through) is deliberate: an unrecognized type is treated as "unknown," which
 * the bridge action then refuses conservatively rather than mis-bridging.
 *
 * @param payload - The relay envelope payload as it arrived.
 */
export function extractPlatformChatType(payload: unknown): PlatformChatType | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const platformData = (payload as { platformData?: unknown }).platformData;
  const parsed = PlatformChatTypeCarrierSchema.safeParse(platformData);
  if (!parsed.success) return undefined;
  return parsed.data.chatType;
}

/**
 * The sender's display name as the platform gave it, or `undefined`.
 *
 * @param payload - The relay envelope payload as it arrived.
 */
export function extractSenderName(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const parsed = SenderNameSchema.safeParse(payload);
  return parsed.success ? parsed.data.senderName : undefined;
}

/**
 * Who wrote this message, as a bridged room's author registry needs them — or
 * `null` when the payload carries no platform user id.
 *
 * **`null` means the message gets NO author and must be dropped with a
 * refusal** (spec §4.1). It must never be folded into a shared "someone":
 * whatever DorkOS cannot identify, it must not pretend to have identified, and
 * merging two strangers into one identity would corrupt the one thing a room
 * log is for. Every real message from every adapter carries an id; the absent
 * case is a malformed or synthetic payload, and refusing it is cheap.
 *
 * The display name is deliberately allowed to be absent — a person with no
 * profile name is still that person, and the registry has a fallback label. The
 * ID is the identity; the name is a render cache.
 *
 * @param payload - The relay envelope payload as it arrived.
 * @param where - The platform and the adapter instance, both parsed off the
 *   relay subject (`parseHumanSubject`), never off the payload: the subject is
 *   how the message was routed, and an identity scoped by anything the sender
 *   can write is not scoped at all.
 * @returns The identity, or `null` when there is no platform user id to key on.
 */
export function externalSenderIdentity(
  payload: unknown,
  where: { platformType: string; instanceId: string }
): ExternalAuthorIdentity | null {
  const platformUserId = extractPlatformUserId(payload);
  if (platformUserId === undefined) return null;
  return {
    platformType: where.platformType,
    instanceId: where.instanceId,
    platformUserId,
    displayName: extractSenderName(payload) ?? '',
  };
}
