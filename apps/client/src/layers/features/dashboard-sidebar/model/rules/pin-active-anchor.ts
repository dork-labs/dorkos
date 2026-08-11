/**
 * The open conversation is always Today's first row (BC-21).
 *
 * @module features/dashboard-sidebar/model/rules/pin-active-anchor
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { anchorKey } from './targets';

/**
 * Today's rows with the open conversation moved to the front and marked as the
 * anchor.
 *
 * **This is the whole answer to "my agent is 40 rows down and I can't see if
 * it's working"** — and it costs no new UI. The anchor carries live status
 * where the operator is already looking.
 *
 * It is deliberately NOT a Heads up item. Heads up means "you are needed"; showing the
 * operator the thing they are already looking at is how a person learns that
 * Heads up can be skimmed past.
 *
 * Runs last in Today's pipeline so nothing can sort or cap it away — selection,
 * archival and the cap each hold the anchor's key open for exactly this.
 *
 * @param rows - Today's ordered rows.
 * @param state - The snapshot.
 */
export function pinActiveAnchor(
  rows: readonly SidebarRowModel[],
  state: SidebarState
): SidebarRowModel[] {
  const key = anchorKey(state);
  if (key === null) return [...rows];
  const found = rows.find((row) => row.key === key);
  if (found === undefined) return [...rows];
  return [{ ...found, reason: 'anchor:active-session' }, ...rows.filter((row) => row.key !== key)];
}
