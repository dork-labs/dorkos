/**
 * Whether a to-do starts an agent turn, and the power that turn runs at (DOR-3088, Security's
 * Musts 1, 4 and 5). Pure: read from the stored row alone, so the card turn, the due wake and a
 * queued turn starting tomorrow all get the same answer.
 *
 * @module services/todos/todo-turn-power
 */
import type { TodoRow } from '@dorkos/db';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import {
  ceilingCarrying,
  hasMarks,
  marksHold,
  type TurnMarks,
} from '../core/turn-power/turn-marks.js';
import { readAuthority, readAuthorityMarks } from './todo-authority.js';

/**
 * The deepest chain that still starts a turn by itself. A to-do made in a turn a depth-2 to-do
 * started is depth 3, and waits for the person (PM decision, 2026-10-18).
 */
export const TODO_TURN_MAX_DEPTH = 2;

/** Whether a to-do starts a turn now, and if not, why. */
export type TodoTurnDecision =
  | { readonly kind: 'start' }
  /** Never a turn: nothing for an agent to run. */
  | { readonly kind: 'none'; readonly reason: 'person-assignee' | 'self-assigned' | 'closed' }
  /** No turn by itself; the person decides (Needs you). */
  | { readonly kind: 'hold'; readonly reason: 'depth' };

/**
 * Whether a to-do starts a turn. These hold on their own, whatever the rooms' limits are set to
 * (`rooms.turnLimitsEnabled: false` included): they never read the room settings.
 *
 * @param row - The stored row.
 */
export function todoTurnDecision(row: TodoRow): TodoTurnDecision {
  if (row.state !== 'open') return { kind: 'none', reason: 'closed' };
  if (!row.agentId) return { kind: 'none', reason: 'person-assignee' };
  // A to-do an agent gives itself is a note to self: kept like a promise, never a turn.
  if (row.assignedByKind === 'agent' && row.assignedBy === row.agentId) {
    return { kind: 'none', reason: 'self-assigned' };
  }
  if (row.chainDepth > TODO_TURN_MAX_DEPTH) return { kind: 'hold', reason: 'depth' };
  return { kind: 'start' };
}

/** The bounds and marks a to-do's turn starts with. */
export interface TodoTurnPower {
  /** Every bound that holds on the turn, or undefined for the agent's own level. */
  readonly ceiling: TurnPermissionCeiling | undefined;
  /** The outsider mark, when the to-do carries it: destructive actions and Permissions ask. */
  readonly carriedMarks: { outsider: true } | undefined;
  /** Every mark the to-do carries. */
  readonly marks: TurnMarks;
}

/**
 * The power a to-do's turn runs at (Musts 1, 3 and 4): its stored authority as the bound, and its
 * stored marks carried, exactly as a marked turn's own deferred effects are.
 *
 * - `person`, `self`, `legacy`: no bound beyond the agent's own level.
 * - A recorded level: that level.
 * - `runtime-default`: the stranger's bound.
 *
 * Teammate marks add their own bound (`ceilingCarrying`), so the turn counts against the space.
 *
 * @param row - The stored row.
 */
export function todoTurnPower(row: Pick<TodoRow, 'authority' | 'authorityMarks'>): TodoTurnPower {
  const authority = readAuthority(row.authority);
  const marks = readAuthorityMarks(row.authorityMarks);
  const bounds: TurnPermissionBound[] = [];
  if (authority.kind === 'runtime-default') bounds.push('runtime-default');
  if (authority.kind === 'level') bounds.push(authority.level);
  const carried = ceilingCarrying(marks);
  if (carried !== undefined) {
    if (Array.isArray(carried)) bounds.push(...(carried as readonly TurnPermissionBound[]));
    else bounds.push(carried as TurnPermissionBound);
  }
  return {
    ceiling: bounds.length === 0 ? undefined : bounds.length === 1 ? bounds[0] : bounds,
    carriedMarks: marksHold(marks) ? { outsider: true } : undefined,
    marks,
  };
}

/**
 * Whether a to-do's turn runs in the person's Direct chat with its agent rather than a chat of its
 * own (DOR-3088, Security's Option A). Read from the stored row at EACH turn start, never fixed
 * when the to-do is made: only the person's own words, proven by their sign-in (`person`
 * authority, which an unproven or no-owner request never gets), with no mark of any kind, and not
 * made from a message, whose words are somebody else's. A to-do an agent, a guest or a stranger
 * touched, or one made from a message, keeps its own chat, so no words but the person's own ever
 * enter the person's conversation.
 *
 * @param row - The stored row.
 */
export function todoRunsInDirectChat(
  row: Pick<TodoRow, 'authority' | 'authorityMarks' | 'sourceRoomEntryId'>
): boolean {
  if (row.sourceRoomEntryId !== null) return false;
  if (readAuthority(row.authority).kind !== 'person') return false;
  return !hasMarks(readAuthorityMarks(row.authorityMarks));
}
