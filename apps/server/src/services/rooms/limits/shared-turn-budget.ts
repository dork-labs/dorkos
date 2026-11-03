/**
 * The rooms' turn budget, shared with the other sources of agent-to-agent turns (to-dos,
 * DOR-3088), so they count in the same install wallet when the rooms' limits are on.
 *
 * @module services/rooms/limits/shared-turn-budget
 */
import type { RoomTurnBudget } from './turn-budget.js';

/** The rooms' turn budget, once the rooms service is built. */
let shared: RoomTurnBudget | undefined;

/**
 * Keep the budget the rooms service uses, so other turn sources can share it.
 *
 * @param budget - The rooms service's budget.
 * @returns The same budget.
 */
export function rememberTurnBudget(budget: RoomTurnBudget): RoomTurnBudget {
  shared = budget;
  return budget;
}

/** The rooms' own turn budget, or undefined until the rooms service is built. */
export function roomTurnBudget(): RoomTurnBudget | undefined {
  return shared;
}
