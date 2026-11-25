/**
 * The person's own reads pass an area a person Blocked for agents (DOR-4978).
 *
 * A caller with no agent identity is decided on the install's default
 * permissions (spec `agent-permissions` D11), and Blocked refuses every tier,
 * reads included. The app is such a caller, so blocking an area for agents
 * stopped the person's own page for it from loading once its reads moved onto
 * the capability mount. A capability's own REST path mints the person proof
 * for every `observe` call (`routes/capability-dispatch.ts`, tagged
 * `rest-proof`), and this is the one thing that proof changes in the gate.
 *
 * @module services/core/capabilities/context/person-read
 */
import type { CapabilityDefinition } from '../capability-definition.js';
import type { CallPermission } from '../permission-enforcement.js';
import { isPersonCaller, type SuppliedCallerProofs } from '../trusted-caller.js';

// The audit observer's grouping key travels with the proof (DOR-4978).
export { personReadGroup } from '../trusted-caller.js';

/**
 * Whether the person's own read passes an area a person Blocked for agents
 * (DOR-4978): an `observe` call, no agent identity, and a REST-path person
 * proof. Only the area's own Blocked default (or the preset's for the area) is
 * skipped; a floor, an action-level setting (the preset's own included) and an
 * unreadable config still refuse, and an `act` or `destructive` call never
 * counts. `/invoke` never mints the REST proof.
 *
 * @param capability - The capability's tier.
 * @param supplied - The call's proofs.
 * @param permission - What the gate resolved for the call.
 * @returns True when the area's Blocked should not apply to this read.
 */
export function personReadsPastArea(
  capability: Pick<CapabilityDefinition, 'tier'>,
  supplied: SuppliedCallerProofs,
  permission: CallPermission | null
): boolean {
  return (
    capability.tier === 'observe' &&
    !supplied.identity &&
    isPersonCaller(supplied.person) &&
    supplied.person.from === 'rest-proof' &&
    permission?.state === 'blocked' &&
    (permission.source === 'default-area' || permission.source === 'preset') &&
    !permission.actionLevel &&
    !permission.unreadable &&
    permission.keeperRefusal === undefined
  );
}
