/**
 * The asks port as Harness Sync (a package's hooks) holds it (spec
 * `computer-side-starts-alone` §5.7): how this computer-side code puts a
 * consent card in front of a person, or reports a standing decision, without
 * reaching across the wall into the space side that builds the card and writes
 * the decision.
 *
 * Startup fills it before any turn runs (`startup/computer-asks.ts`). Until
 * then it fails closed: every ask answers `unwired` and nothing is recorded,
 * so nothing is allowed and a person is asked again later.
 *
 * @module services/harness/computer-asks
 */
import {
  createComputerAsksSlot,
  type ComputerAsks,
  type HookProjectionRequest,
} from '@dorkos/shared/computer-asks';

const slot = createComputerAsksSlot();

/**
 * Hand this code the asks port, or clear it.
 *
 * @param next - The port, or `undefined` to clear it.
 */
export function setHarnessAsks(next: ComputerAsks | undefined): void {
  slot.set(next);
}

/** The asks port, or the fail-closed one before startup hands it over. */
export function harnessAsks(): ComputerAsks {
  return slot.get();
}

/**
 * Have the space side pin today's files onto a package's yes recorded before
 * files were pinned (`hookApprovalMatch` answered `unpinned`), so the next
 * edit to them needs a new yes. The running server only; the read-only
 * `--check` path never reports this.
 *
 * @param request - The projection whose yes to pin.
 */
export function pinLegacyHookFiles(request: HookProjectionRequest): void {
  slot.get().record({ kind: 'hook_files_pinned', request });
}
