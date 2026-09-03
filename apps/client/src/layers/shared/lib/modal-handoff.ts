/**
 * Handing off from a modal flyout to whatever it was a door to.
 *
 * @module shared/lib/modal-handoff
 */

/**
 * Wrap an action so the flyout it was pressed in closes FIRST.
 *
 * ## The hazard this exists for
 *
 * A modal popover holds `body { pointer-events: none }` while it is open. So a
 * handler that opens a route, a dialog or another flyout without closing its own
 * lands the person on an inert screen — or stacks a second modal on top of the
 * lock — and the affordance they pressed was, by construction, a door. The
 * Control Center's overrides ledger hit this first; the Remote-access row's
 * "Fix…" and the beacon flyout's "Manage…" are the same shape, so all three
 * share this one helper rather than three copies of the ordering.
 *
 * It is deliberately a plain function over a `close` callback rather than a hook
 * over a store flag: the three call sites close three different things (the
 * Control Center, and the beacon's own popover via its `onClose`), and the only
 * thing they have in common is the ORDER.
 *
 * @param close - Dismisses the flyout the action was pressed in.
 * @returns A wrapper that turns an action into one which closes, then acts.
 */
export function createModalHandoff(close: () => void): (go: () => void) => () => void {
  return (go: () => void) => () => {
    close();
    go();
  };
}
