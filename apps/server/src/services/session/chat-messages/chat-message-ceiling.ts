/**
 * What a chat message carries from the chat that sent it. A message runs at its receiving agent's
 * own level (Dorian 2026-10-30, DOR-3440); only a teammate's chain in a shared space rides on.
 *
 * @module services/session/chat-messages/chat-message-ceiling
 */
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { ceilingCarrying, marksOfLevel } from '../../core/turn-power/turn-marks.js';
import { unknownLevelMarks } from '../../core/turn-power/turn-levels.js';
import type { TurnOrigin } from '../origin/turn-origin.js';

/** What a row stores when its sender's turn carried no teammate's chain. */
const NO_BOUND = 'none';

/**
 * What a chat message row stores as its sender's bound (`ceilingJson`).
 *
 * @param deps - Reads the sending chat's level (`passedOnLevelOf`).
 * @param caller - The sending chat and its agent.
 */
export function senderCeilingJson(
  deps: { turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined },
  caller: { sessionId: string; agentPath: string }
): string {
  const level = deps.turnLevelOf(caller.sessionId);
  const marks =
    level !== undefined
      ? marksOfLevel(level)
      : unknownLevelMarks([caller.sessionId], caller.agentPath);
  return JSON.stringify(ceilingCarrying(marks) ?? NO_BOUND);
}

/** A ceiling as the list of bounds that all hold. */
export function boundsOf(ceiling: TurnPermissionCeiling): readonly TurnPermissionBound[] {
  return Array.isArray(ceiling)
    ? (ceiling as readonly TurnPermissionBound[])
    : [ceiling as TurnPermissionBound];
}

/**
 * The teammate's chain a stored bound holds, as a record that lowers nothing, or `undefined` for any
 * other row. An earlier build stored the chain in a list beside its cap, so what it stored lowers
 * nothing either.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCeiling(json: string): TurnPermissionCeiling | undefined {
  try {
    const value = JSON.parse(json) as unknown;
    const bounds = (Array.isArray(value) ? value : [value]) as { teammate?: unknown }[];
    const carrier = bounds.find(
      (bound) => typeof bound === 'object' && bound !== null && Array.isArray(bound.teammate)
    );
    if (carrier === undefined) return undefined;
    return ceilingCarrying({ teammate: carrier.teammate as TurnPermissionLevel['teammate'] });
  } catch {
    return undefined;
  }
}

/**
 * The origin of the turn a chat message starts.
 */
export const CHAT_MESSAGE_ORIGIN: TurnOrigin = { kind: 'chat-message' };
