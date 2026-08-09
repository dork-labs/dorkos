/**
 * The order Today comes in, and where it stops — user-interaction recency, and
 * a soft cap of eight (BC-16, BC-20).
 *
 * This is the single most important behavioural promise in the redesign: **a
 * row never moves because an agent did something.** A `session_status` event, a
 * tool call or an agent's post changes nothing here, because none of them is an
 * input. Only the operator's own attention is.
 *
 * @module features/dashboard-sidebar/model/rules/order-today
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { anchorKey, epochMs, interactionKeyOf } from './targets';

/**
 * How many rows Today shows before the automated reveal.
 *
 * Eight, matching `MAX_JUMP_BACK_IN` — a reading limit, not a fetch limit. A
 * list long enough to scan is a list you have to scan, and everything past it
 * is one ⌘K away.
 */
export const TODAY_SOFT_CAP = 8;

/**
 * When the OPERATOR last touched this row's subject — `max(userLastMessageAt,
 * userLastOpenedAt)` — or `null` when they never have.
 *
 * Both halves are optional and the maximum of what is present wins. A runtime
 * that cannot say when the user last wrote simply contributes nothing, and the
 * interaction timestamp alone governs: omission, never a guess, the same
 * honesty rule the verb ladder runs on.
 *
 * @param row - The row.
 * @param state - The snapshot.
 */
export function lastInteractionAt(row: SidebarRowModel, state: SidebarState): number | null {
  const key = interactionKeyOf(row.target);
  if (key === null) return null;
  const opened = epochMs(state.interactions[key]);
  const messaged = epochMs(state.userLastMessageAt[key]);
  if (opened === null) return messaged;
  if (messaged === null) return opened;
  return Math.max(opened, messaged);
}

/**
 * Whether a row is exempt from the soft cap.
 *
 * The anchor, because it is where the operator is standing; a directed unread,
 * because somebody addressed them by name and a cap is not a reason to hide
 * that.
 *
 * @param row - The row.
 * @param anchor - The anchor's key, or `null`.
 */
function exemptFromCap(row: SidebarRowModel, anchor: string | null): boolean {
  return row.key === anchor || row.unread.tier === 'directed';
}

/**
 * Today's rows, most recently touched by the operator first, capped.
 *
 * Rollup rows (the automated reveal) are pinned to the end whatever else
 * happens: they summarize what is below the list rather than competing for a
 * place in it.
 *
 * The row key breaks ties, so two rows touched in the same millisecond never
 * swap places between renders — the tie-reshuffle bug the rooms work has
 * already been bitten by.
 *
 * @param rows - Today's eligible rows.
 * @param state - The snapshot.
 */
export function orderToday(
  rows: readonly SidebarRowModel[],
  state: SidebarState
): SidebarRowModel[] {
  const rollups = rows.filter((row) => row.target.kind === 'rollup');
  const ordered = rows
    .filter((row) => row.target.kind !== 'rollup')
    .map((row) => ({ row, at: lastInteractionAt(row, state) }))
    .sort((a, b) => {
      const atA = a.at ?? Number.NEGATIVE_INFINITY;
      const atB = b.at ?? Number.NEGATIVE_INFINITY;
      if (atA !== atB) return atB - atA;
      return a.row.key.localeCompare(b.row.key);
    })
    .map((entry) => entry.row);

  const anchor = anchorKey(state);
  const capped: SidebarRowModel[] = [];
  let spent = 0;
  for (const row of ordered) {
    if (exemptFromCap(row, anchor)) {
      capped.push(row);
      continue;
    }
    if (spent >= TODAY_SOFT_CAP) continue;
    spent += 1;
    capped.push(row);
  }
  return [...capped, ...rollups];
}
