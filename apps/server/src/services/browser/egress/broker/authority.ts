import type { EgressBinding } from '../settings.js';
/** Trusted producer evidence, never supplied by a proxy request or a viewer. */
export interface AuthorityObservation {
  readonly binding: EgressBinding;
  readonly ownerExists: true;
  readonly retainedRun: true;
  readonly grantsCurrent: true;
  readonly custodyKnown: true;
  readonly runtimePolicyKnown: true;
  readonly runtimeIdentity: string;
  readonly authorizationEpoch: number;
  readonly policyRevision: number;
  readonly inventoryRevision: number;
  readonly monotonicNow: number;
  readonly utcNow: number;
  readonly utcExpiresAt: number;
}
/** Complete declared-instance coverage is separate from permanent policy address denies. */
export interface InventoryObservation {
  readonly revision: number;
  readonly publicAuthoritiesKnown: true;
  readonly localCoverageComplete: boolean;
  readonly validUntil: number;
  readonly protectedEndpoints: readonly { address: string; port: number }[];
  readonly declaredInstances: readonly string[];
  readonly coveredInstances: readonly string[];
}
/** Only a trusted server lifecycle producer may implement this private port. No default exists. */
export interface AuthorityPorts {
  readonly readCurrent: (binding: EgressBinding) => AuthorityObservation;
  readonly readAuthority: (
    binding: EgressBinding,
    signal: AbortSignal
  ) => Promise<AuthorityObservation>;
  readonly readInventory: () => InventoryObservation;
}
/** Complete binding equality includes browser lifetime, never just a profile name. */
export function sameBinding(a: EgressBinding, b: EgressBinding): boolean {
  return (
    a.ownerId === b.ownerId &&
    a.workspaceId === b.workspaceId &&
    a.browserId === b.browserId &&
    a.browserGeneration === b.browserGeneration
  );
}
