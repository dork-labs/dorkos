import {
  accessLevelRevisionIds,
  type ConnectorReconciliationCandidate,
} from '@dorkos/shared/connector-schemas';

/**
 * How the account offers changing things: as the Read and write level, only
 * one action at a time (no level covers them), or not at all.
 */
export type RequestedWriteOffer = 'level' | 'exact' | 'none';

/**
 * How an account's actions offer changing things (DOR-4193): Read and write
 * adds non-paid actions over Read, or changes need exact actions, or there
 * are none. The level sets use the same candidates and rule as server grants.
 *
 * @param candidates - The account's actions in one access snapshot.
 */
export function requestedWriteOffer(
  candidates: readonly ConnectorReconciliationCandidate[]
): RequestedWriteOffer {
  const readWrite = accessLevelRevisionIds(candidates, 'read-write').length;
  if (readWrite > accessLevelRevisionIds(candidates, 'read').length) return 'level';
  return candidates.some((c) => c.supported && c.capabilityClassification !== 'read')
    ? 'exact'
    : 'none';
}
