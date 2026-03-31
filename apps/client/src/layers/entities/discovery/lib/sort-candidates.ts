import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

/**
 * Sort candidates by relevance: dork-manifest first, then alphabetically by path.
 * Only applied after scan completes to avoid cards jumping during progressive results.
 */
export function sortCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return [...candidates].sort((a, b) => {
    const aIsDork = a.strategy === 'dork-manifest';
    const bIsDork = b.strategy === 'dork-manifest';
    if (aIsDork !== bIsDork) return aIsDork ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}
