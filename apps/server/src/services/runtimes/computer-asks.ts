/**
 * The asks port as the runtimes' own checks (an agent folder's allow list and settings, a repo's settings) holds it (spec
 * `computer-side-starts-alone` §5.7): how this computer-side code puts a
 * consent card in front of a person, or reports a standing decision, without
 * reaching across the wall into the space side that builds the card and writes
 * the decision.
 *
 * Startup fills it before any turn runs (`startup/computer-asks.ts`). Until
 * then it fails closed: every ask answers `unwired` and nothing is recorded,
 * so nothing is allowed and a person is asked again later.
 *
 * @module services/runtimes/computer-asks
 */
import { createComputerAsksSlot, type ComputerAsks } from '@dorkos/shared/computer-asks';

const slot = createComputerAsksSlot();

/**
 * Hand this code the asks port, or clear it.
 *
 * @param next - The port, or `undefined` to clear it.
 */
export function setRuntimeAsks(next: ComputerAsks | undefined): void {
  slot.set(next);
}

/** The asks port, or the fail-closed one before startup hands it over. */
export function runtimeAsks(): ComputerAsks {
  return slot.get();
}
