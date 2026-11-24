/**
 * The payload field that carries what a message's sender holds onto the turn
 * it starts (DOR-5151), and the one way to read a payload without it.
 *
 * @module relay/lib/carried-turn-limits
 */

/**
 * The payload field that carries the limits the sender's own turns hold onto
 * the turn its message starts: `{ permissionCeiling?, carriedMarks? }`, as
 * `launcherTurnCeiling` builds them on the server. The server sets it; a route
 * that forwards a caller's payload removes the caller's copy. Every bound in
 * it can only hold a turn lower, never raise it. It is never part of the
 * message's words: {@link withoutCarriedTurnLimits} drops it wherever a
 * payload is read as text or shown.
 */
export const CARRIED_TURN_LIMITS_FIELD = '__carriedTurnLimits';

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
