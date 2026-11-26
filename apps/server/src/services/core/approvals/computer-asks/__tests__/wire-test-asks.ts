/**
 * Wire the computer side's asks to the space side's for a test, as startup
 * does (`startup/computer-asks.ts`), raising cards through `approvals`.
 *
 * @module services/core/approvals/computer-asks/__tests__/wire-test-asks
 */
import { wireComputerAsks } from '../../../../../startup/computer-asks.js';
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import { computerAsks, setAskApprovals, type AskApprovals } from '../index.js';

/**
 * Hand every computer-side slot the space side's asks, and the asks this
 * approval primitive. `null` raises no card (every ask answers `unwired`) but
 * still records standing decisions, as a server before its approvals step.
 *
 * @param approvals - The approval primitive, or `null`.
 * @returns The port every slot now holds.
 */
export function wireTestAsks(approvals: AskApprovals | null = null): ComputerAsks {
  setAskApprovals(approvals);
  wireComputerAsks();
  return computerAsks;
}
