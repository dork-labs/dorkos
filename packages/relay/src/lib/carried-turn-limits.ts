/**
 * The payload field that carries what a message's sender holds onto the turn
 * it starts (DOR-5151), the one way to read a payload without it, and the
 * seal that tells the server's copy from anyone else's (DOR-5201).
 *
 * @module relay/lib/carried-turn-limits
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The payload field that carries the limits the sender's own turns hold onto
 * the turn its message starts: `{ permissionCeiling?, carriedMarks?, seal? }`,
 * as `launcherTurnCeiling` builds them on the server. The server sets it; a
 * route that forwards a caller's payload removes the caller's copy. Every bound
 * in it can only hold a turn lower, never raise it. It is never part of the
 * message's words: {@link withoutCarriedTurnLimits} drops it wherever a
 * payload is read as the message's words (the prompt and the conversation
 * preview). Raw envelope reads, such as dead letters and an inbox, still show
 * it as stored.
 */
export const CARRIED_TURN_LIMITS_FIELD = '__carriedTurnLimits';

/**
 * The key this process seals the server's copy with. Made fresh at start and
 * never written anywhere, so no caller can compute a seal. A message stored
 * before a restart no longer verifies, and is read as unsealed.
 */
const SEAL_KEY = randomBytes(32);

/** The seal over the limits as stamped, tied to the sender they were stamped for. */
function sealOf(from: string, limits: Record<string, unknown>): string {
  return createHmac('sha256', SEAL_KEY)
    .update(`${from}\n${JSON.stringify(limits)}`)
    .digest('base64url');
}

/**
 * The limits as the server stamps them onto a message from `from`, sealed, so
 * the turn they reach knows the server wrote them ({@link isSealedTurnLimits}).
 *
 * The seal proves only that code running in this server process wrote the
 * limits: this function is exported, so anything loaded into the process can
 * call it. It keeps a caller off the wire (an HTTP or bridge payload, a stored
 * envelope read back) from forging a stamp; it is no fence inside the process.
 * It covers the sender and the limits, not the subject or the message id, so
 * an identical stamp for the same sender reads as sealed on another message.
 *
 * @param from - The sender the server sends the message from.
 * @param limits - The limits the sender's own turns hold.
 */
export function sealTurnLimits(
  from: string,
  limits: Record<string, unknown>
): Record<string, unknown> {
  return { ...limits, seal: sealOf(from, limits) };
}

/**
 * Whether these carried limits are exactly what this server stamped for this
 * sender ({@link sealTurnLimits}). A copy anyone else wrote, one changed on the
 * way, one moved to another sender, or one stamped before a restart is not.
 *
 * @param from - The envelope's sender.
 * @param carried - The value of {@link CARRIED_TURN_LIMITS_FIELD}.
 */
export function isSealedTurnLimits(from: string, carried: Record<string, unknown>): boolean {
  const { seal, ...limits } = carried;
  if (typeof seal !== 'string') return false;
  const expected = Buffer.from(sealOf(from, limits));
  const given = Buffer.from(seal);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A payload as its sender wrote it, without the limits the server added.
 * Anything but an object carrying the field is returned as it is.
 *
 * @param payload - A relay envelope's payload.
 */
export function withoutCarriedTurnLimits(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !(CARRIED_TURN_LIMITS_FIELD in payload)) {
    return payload;
  }
  const { [CARRIED_TURN_LIMITS_FIELD]: _carried, ...words } = payload as Record<string, unknown>;
  return words;
}
