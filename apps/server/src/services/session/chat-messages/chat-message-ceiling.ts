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
import { chatReadOutsideWords } from '../../core/turn-power/chat-outside-words.js';
import type { TurnOrigin } from '../origin/turn-origin.js';

/** What a row stores when its sender's turn carried no teammate's chain. */
const NO_BOUND = 'none';

/** The bound a row stores beside its teammate's chain when its sender's turn held a Wi-Fi hold. */
const CARRIED_HOLD = { carriedOutsider: true } as const;

/**
 * The bound a row stores when its sender's chat had read outside words (DOR-4029): the turn it
 * starts is noted as one that read them too. A record, never a cap or a mark: it lowers nothing.
 */
const CARRIED_WORDS = { carriedWords: true } as const;

/**
 * What a chat message row stores as its sender's bound (`ceilingJson`): a teammate's chain, the
 * sender's Wi-Fi hold, which the turn it starts carries as a mark (DOR-3561), never a cap, and
 * whether the sender's chat had read outside words, which the turn it starts is noted with
 * (DOR-4029). Kept on the row, so a message queued before a restart still carries them.
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
  // A hold carries the sender's outside words with it (`parseCarriedWords`); only an unheld
  // sender's words need a bound of their own.
  const held = marksHold(marksOf(caller.sessionId, caller.agentPath)) || marksHold(atTurnEnd);
  const flag = held
    ? CARRIED_HOLD
    : chatReadOutsideWords(caller.sessionId, caller.agentPath)
      ? CARRIED_WORDS
      : undefined;
  if (flag === undefined) return JSON.stringify(carried ?? NO_BOUND);
  return JSON.stringify(carried === undefined ? [flag] : [carried, flag]);
}

/** Whether one stored bound (or list of them) holds an object with `key` set to `true`. */
function storedFlag(json: string, key: 'carriedOutsider' | 'carriedWords'): boolean {
  try {
    const value = JSON.parse(json) as unknown;
    return (Array.isArray(value) ? value : [value]).some(
      (bound) =>
        typeof bound === 'object' &&
        bound !== null &&
        (bound as Record<string, unknown>)[key] === true
    );
  } catch {
    return false;
  }
}

/**
 * Whether a stored bound carries its sender's Wi-Fi hold on (DOR-3561). A row from before the
 * hold was stored carries none.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCarriedHold(json: string): boolean {
  return storedFlag(json, 'carriedOutsider');
}

/**
 * Whether a stored bound carries its sender's outside words on (DOR-4029). A held sender's row
 * carries them too; a row from before they were stored carries its hold alone, and that counts.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCarriedWords(json: string): boolean {
  return storedFlag(json, 'carriedWords') || storedFlag(json, 'carriedOutsider');
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
 * Whether any sending row behind a queue row carries its sender's outside words on (DOR-4029).
 *
 * @param rows - The chat message rows batched into the queue row.
 */
export function rowsCarryWords(rows: readonly { ceilingJson: string }[]): boolean {
  return rows.some((row) => parseCarriedWords(row.ceilingJson));
}

/**
 * Whether a sender's Wi-Fi hold, or the outside words its chat read, keep its words out of another
 * chat's running turn: the running turn holds no hold (a running turn cannot be marked, DOR-3561)
 * or read none (DOR-4029). They wait for the next turn, which the row marks and notes at launch.
 *
 * @param fromSessionId - The sending chat.
 * @param toSessionId - The chat whose turn is running.
 */
export function holdBlocksSteer(fromSessionId: string, toSessionId: string): boolean {
  if (marksHold(marksOf(fromSessionId, undefined)) && !marksHold(marksOf(toSessionId, undefined))) {
    return true;
  }
  return chatReadOutsideWords(fromSessionId) && !chatReadOutsideWords(toSessionId);
}

/**
 * The origin of the turn a chat message starts.
 */
export const CHAT_MESSAGE_ORIGIN: TurnOrigin = { kind: 'chat-message' };
