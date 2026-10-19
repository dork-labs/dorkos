/**
 * The sender's bound a chat message carries, read back from its row, and what
 * it means for the chat the message opens.
 *
 * @module services/session/chat-messages/chat-message-ceiling
 */
import type { TurnPermissionBound, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { TurnOrigin } from '../origin/turn-origin.js';

/**
 * Read a stored ceiling; anything unreadable is the runtime's default.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCeiling(json: string): TurnPermissionBound {
  try {
    const value = JSON.parse(json) as unknown;
    if (value === 'runtime-default') return value;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { asks?: unknown }).asks === 'string' &&
      typeof (value as { reach?: unknown }).reach === 'string'
    ) {
      return value as TurnPermissionLevel;
    }
  } catch {
    // fall through
  }
  return 'runtime-default';
}

/**
 * Whether the sending turn was marked: it read words DorkOS cannot vouch for,
 * or its level is not known (which is bounded the same way).
 *
 * @param bound - The sender's bound.
 */
export function isMarkedBound(bound: TurnPermissionBound): boolean {
  return bound === 'runtime-default' || bound.outsider === true;
}

/**
 * The origin of the turn a chat message starts. A message from a marked turn
 * opens a chat that does NOT inherit its agent's own level (DOR-3107,
 * Security): an agent set to Full autonomy that a stranger's words reached
 * must not hand that level to a chat it opens.
 *
 * @param ceilingJson - The message row's stored sender bound.
 */
export function chatMessageOrigin(ceilingJson: string): TurnOrigin {
  return isMarkedBound(parseCeiling(ceilingJson))
    ? { kind: 'chat-message', marked: true }
    : { kind: 'chat-message' };
}
