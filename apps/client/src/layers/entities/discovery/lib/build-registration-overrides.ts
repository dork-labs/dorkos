import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

/**
 * Build the registration overrides from a candidate's discovery hints.
 *
 * Shared between onboarding and agents-page discovery flows to avoid
 * duplicating the hints-to-overrides mapping.
 *
 * @param candidate - The discovery candidate with extraction hints
 * @returns Partial manifest overrides for agent registration
 */
export function buildRegistrationOverrides(candidate: DiscoveryCandidate) {
  return {
    name: candidate.hints.suggestedName,
    runtime: candidate.hints.detectedRuntime,
    ...(candidate.hints.inferredCapabilities
      ? { capabilities: candidate.hints.inferredCapabilities }
      : {}),
    ...(candidate.hints.description ? { description: candidate.hints.description } : {}),
  };
}
