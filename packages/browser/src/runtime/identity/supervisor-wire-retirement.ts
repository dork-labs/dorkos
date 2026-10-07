import type {
  ProcessIdentity,
  ProcessObservation,
  ProcessTreeObservation,
} from '../../configuration.js';
import { completeInventory } from '../../lifecycle/inventory.js';
import {
  acceptsOriginalWireRetirementCandidate,
  type createSupervisorProtocolWire,
} from './supervisor-protocol-wire.js';

/** Private classifier of retained launcher facts; never an authority or caller-supplied proof. */
export function classifyOriginalWireRetirement(
  facts: Readonly<{
    wire: ReturnType<typeof createSupervisorProtocolWire>;
    result: PromiseSettledResult<unknown>;
    originalBrowserStop: PromiseSettledResult<unknown>;
    originalReturnedAccepted: boolean;
    otherOriginalsKnown: boolean;
    root: ProcessIdentity;
    tree: ProcessTreeObservation;
    statuses: readonly ProcessObservation[];
  }>
): boolean {
  if (
    facts.result.status !== 'rejected' ||
    facts.originalBrowserStop.status !== 'fulfilled' ||
    !facts.originalReturnedAccepted ||
    !facts.otherOriginalsKnown ||
    facts.tree.status !== 'complete' ||
    facts.statuses.length !== facts.tree.identities.length ||
    facts.statuses.length === 0 ||
    facts.statuses.some((value) => value.status !== 'dead')
  )
    return false;
  try {
    completeInventory(facts.tree, facts.root);
    return acceptsOriginalWireRetirementCandidate(facts.wire, facts.result.reason);
  } catch {
    return false;
  }
}
