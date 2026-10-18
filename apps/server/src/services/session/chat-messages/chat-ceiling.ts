/**
 * How a chat message's ceiling is stored and read back (spec `spin-off-chats`
 * §3): the sender's bound, and on Trusted whether DorkOS vouched for the sender
 * (ADR `261018-030117`). Kept in the row, so a row adopted after a restart
 * launches under the same ceiling it was sent with.
 *
 * @module services/session/chat-messages/chat-ceiling
 */
import type { TurnPermissionBound, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';

/**
 * The ceiling a message from a chat carries: the level its latest turn ran
 * at, or the receiving runtime's default when that is not known (a restart, a
 * chat this process never ran a turn on). Never looser than the sender.
 *
 * @param level - The sending chat's latest turn level, when known.
 */
export function senderCeiling(level: TurnPermissionLevel | undefined): TurnPermissionBound {
  return level ?? 'runtime-default';
}

/** A stored ceiling: the sender's bound, and whether DorkOS vouched for the sender. */
export interface StoredCeiling {
  /** The sender's bound: its level, or the runtime's default when unknown. */
  bound: TurnPermissionBound;
  /** Whether DorkOS vouched for the sender as the message was sent. */
  vouched: boolean;
}

/**
 * The JSON a message's ceiling is stored as: the bare bound, as before, or
 * `{ vouched: true, bound }` for a vouched sender. The bound is kept either
 * way, so a switch to Careful before the row launches still holds it.
 *
 * @param bound - The sender's bound, from {@link senderCeiling}.
 * @param vouched - Whether DorkOS vouched for the sender.
 */
export function storedCeiling(bound: TurnPermissionBound, vouched: boolean): string {
  return JSON.stringify(vouched ? { vouched: true, bound } : bound);
}

/** Read a bare stored bound; anything unreadable is the runtime's default. */
function parseBound(value: unknown): TurnPermissionBound {
  if (value === 'runtime-default') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { asks?: unknown }).asks === 'string' &&
    typeof (value as { reach?: unknown }).reach === 'string'
  ) {
    return value as TurnPermissionLevel;
  }
  return 'runtime-default';
}

/**
 * Read a stored ceiling; anything unreadable is the runtime's default, unvouched.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCeiling(json: string): StoredCeiling {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { bound: 'runtime-default', vouched: false };
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { vouched?: unknown }).vouched === true &&
    'bound' in value
  ) {
    const bound = parseBound((value as { bound: unknown }).bound);
    // A marked level is never vouched, whatever the row says.
    return { bound, vouched: bound === 'runtime-default' || bound.outsider !== true };
  }
  return { bound: parseBound(value), vouched: false };
}
