/**
 * Hand the computer side the asks port (spec `computer-side-starts-alone`
 * §5.7): the space side's cards and standing-decision writes
 * (`services/core/approvals/computer-asks/`), filled into the slot each
 * computer-side folder that asks keeps. Runs before any step that can start a
 * turn, so an upgrade pin or a first-use pin is never dropped; the approval
 * service the cards are raised through comes later (`setAskApprovals`).
 *
 * Each slot's unset answer is fail-closed (nobody asked, nothing recorded), so
 * code that asks before this runs allows less, never more.
 *
 * @module startup/computer-asks
 */
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import { computerAsks } from '../services/core/approvals/computer-asks/index.js';
import { setHarnessAsks } from '../services/harness/computer-asks.js';
import { setRuntimeAsks } from '../services/runtimes/computer-asks.js';
import { setWorkspaceAsks } from '../services/workspace/computer-asks.js';

/**
 * Fill every computer-side asks slot with one port.
 *
 * @param asks - The port; the space side's own by default.
 */
export function wireComputerAsks(asks: ComputerAsks = computerAsks): void {
  setRuntimeAsks(asks);
  setHarnessAsks(asks);
  setWorkspaceAsks(asks);
}
