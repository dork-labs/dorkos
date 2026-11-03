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
import {
  ceilingCarrying,
  marksHold,
  marksOfLevel,
  mergeMarks,
  NO_MARKS,
  type TurnMarks,
} from '../../core/turn-power/turn-marks.js';
import { marksOf, unknownLevelMarks } from '../../core/turn-power/turn-levels.js';
import type { TurnOrigin } from '../origin/turn-origin.js';

/** What a row stores when its sender's turn carried no teammate's chain. */
const NO_BOUND = 'none';

/** The bound a row stores beside its teammate's chain when its sender's turn held a Wi-Fi hold. */
const CARRIED_HOLD = { carriedOutsider: true } as const;

/**
 * What a chat message row stores as its sender's bound (`ceilingJson`): a teammate's chain, and
 * the sender's Wi-Fi hold, which the turn it starts carries as a mark (DOR-3561), never a cap.
 *
 * A report can go long after the turn it speaks for, while the sender's latest turn is unmarked,
 * so `caller.marksAtTurnEnd` keeps that turn's marks on the row (DOR-3720). Only the server's own
 * report path sets it; no tool's input reaches a caller.
 *
 * @param deps - Reads the sending chat's level (`passedOnLevelOf`).
 * @param caller - The sending chat and its agent, and for a report the marks of its turn.
 */
export function senderCeilingJson(
  deps: { turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined },
  caller: { sessionId: string; agentPath: string; marksAtTurnEnd?: TurnMarks }
): string {
  const atTurnEnd = caller.marksAtTurnEnd ?? NO_MARKS;
  const level = deps.turnLevelOf(caller.sessionId);
  const marks =
    level !== undefined
      ? marksOfLevel(level)
      : unknownLevelMarks([caller.sessionId], caller.agentPath);
  const carried = ceilingCarrying(mergeMarks(marks, atTurnEnd));
  if (!marksHold(marksOf(caller.sessionId, caller.agentPath)) && !marksHold(atTurnEnd)) {
    return JSON.stringify(carried ?? NO_BOUND);
  }
  return JSON.stringify(carried === undefined ? [CARRIED_HOLD] : [carried, CARRIED_HOLD]);
}

/**
 * Whether a stored bound carries its sender's Wi-Fi hold on (DOR-3561). A row from before the
 * hold was stored carries none.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCarriedHold(json: string): boolean {
  try {
    const value = JSON.parse(json) as unknown;
    return (Array.isArray(value) ? value : [value]).some(
      (bound) =>
        typeof bound === 'object' &&
        bound !== null &&
        (bound as { carriedOutsider?: unknown }).carriedOutsider === true
    );
  } catch {
    return false;
  }
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
 * The ceiling a queue row launches under, from every sending row behind it: a teammate's chain any
 * sender carried, or nothing.
 *
 * @param rows - The chat message rows batched into the queue row.
 */
export function rowsCeiling(
  rows: readonly { ceilingJson: string }[]
): TurnPermissionCeiling | undefined {
  const bounds = rows.flatMap((row) => {
    const ceiling = parseCeiling(row.ceilingJson);
    return ceiling === undefined ? [] : boundsOf(ceiling);
  });
  return bounds.length === 0 ? undefined : bounds;
}

/**
 * Whether any sending row behind a queue row carries its sender's Wi-Fi hold on (DOR-3561).
 *
 * @param rows - The chat message rows batched into the queue row.
 */
export function rowsCarryHold(rows: readonly { ceilingJson: string }[]): boolean {
  return rows.some((row) => parseCarriedHold(row.ceilingJson));
}

/**
 * Whether a sender's Wi-Fi hold keeps its words out of another chat's running turn: the running
 * turn holds none, and a running turn cannot be marked (DOR-3561). They wait for the next turn,
 * which the row marks.
 *
 * @param fromSessionId - The sending chat.
 * @param toSessionId - The chat whose turn is running.
 */
export function holdBlocksSteer(fromSessionId: string, toSessionId: string): boolean {
  return (
    marksHold(marksOf(fromSessionId, undefined)) && !marksHold(marksOf(toSessionId, undefined))
  );
}

/**
 * The origin of the turn a chat message starts.
 */
export const CHAT_MESSAGE_ORIGIN: TurnOrigin = { kind: 'chat-message' };
