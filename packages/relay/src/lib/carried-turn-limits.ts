/**
 * The payload field that carries what a message's sender holds onto the turn
 * it starts (DOR-5151), the one way to read a payload without it, the seal
 * that tells the server's copy from anyone else's (DOR-5201), and where the
 * server placed a new chat the message starts (DOR-5209).
 *
 * @module relay/lib/carried-turn-limits
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The payload field that carries the limits the sender's own turns hold onto
 * the turn its message starts: `{ permissionCeiling?, carriedMarks?, newChat?, seal? }`,
 * as `launcherTurnCeiling` builds them on the server. The server sets it; a
 * route that forwards a caller's payload removes the caller's copy. Every bound
 * in it can only hold a turn lower, never raise it. `newChat` is where the
 * server placed the chat the message starts ({@link sealedNewChatPlace}). It is never part of the
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

/**
 * Where the server placed a new chat a message starts (DOR-5209): the folder it
 * opens in and the agent it runs as, decided by the sessions route's own place
 * rule. Tied to the key the turn runs under, so it places that chat only.
 */
export interface NewChatPlace {
  /** The key the message's turn runs under. */
  sessionKey: string;
  /** The folder the chat opens in. */
  cwd?: string;
  /** The home of the agent the chat runs as. */
  forAgent?: string;
}

/**
 * The place the server sealed onto this message for the new chat under
 * `sessionKey` ({@link NewChatPlace}), or `undefined` when there is none: no
 * place, a copy the server did not seal for this sender, or a place for
 * another chat.
 *
 * @param payload - A relay envelope's payload.
 * @param from - The envelope's sender.
 * @param sessionKey - The key the message's turn runs under.
 */
export function sealedNewChatPlace(
  payload: unknown,
  from: string,
  sessionKey: string
): Omit<NewChatPlace, 'sessionKey'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const carried = (payload as Record<string, unknown>)[CARRIED_TURN_LIMITS_FIELD];
  if (typeof carried !== 'object' || carried === null) return undefined;
  const limits = carried as Record<string, unknown>;
  if (!isSealedTurnLimits(from, limits)) return undefined;
  const place = limits.newChat;
  if (typeof place !== 'object' || place === null) return undefined;
  const { sessionKey: key, cwd, forAgent } = place as Record<string, unknown>;
  if (key !== sessionKey) return undefined;
  return {
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    ...(typeof forAgent === 'string' && forAgent !== '' ? { forAgent } : {}),
  };
}

/**
 * Whether this message carries a new chat's place that the server did not seal
 * for this sender: one anyone else wrote, one changed on the way, or one sealed
 * before a restart. A place sealed for this sender but another chat is not
 * counted here; {@link sealedNewChatPlace} ignores it.
 *
 * @param payload - A relay envelope's payload.
 * @param from - The envelope's sender.
 */
export function carriesUnsealedNewChat(payload: unknown, from: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const carried = (payload as Record<string, unknown>)[CARRIED_TURN_LIMITS_FIELD];
  if (typeof carried !== 'object' || carried === null || !('newChat' in carried)) return false;
  return !isSealedTurnLimits(from, carried as Record<string, unknown>);
}
