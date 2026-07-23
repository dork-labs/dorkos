/**
 * The single composition root for DorkOS's Capability Registry (spec
 * `capability-registry`, task 2.3).
 *
 * {@link composeDorkOsCapabilityRegistry} folds the migrated domains — operator,
 * marketplace, and the self-description domain — into ONE immutable registry.
 * Composing them together (rather than one registry per surface) is what restores
 * cross-domain duplicate detection: a tool name or capability id claimed by two
 * different domains throws at boot. It then back-writes the composed registry onto
 * the shared dependency bag so `capabilities.list` can serialize the registry it
 * belongs to (the late-binding self-reference; see `capabilities-domain.ts`).
 *
 * A domain is included only when its service handles are present in `deps`:
 * `operatorDeps` gates the operator domain, `marketplaceDeps` the marketplace
 * domain, and the self-description domain is always present. Every included
 * domain's `assertDeps` runs inside `composeRegistry`, so a domain admitted
 * without its deps fails fast at boot.
 *
 * @module services/core/self-description/dorkos-registry
 */
import {
  composeRegistry,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityRegistry,
} from '../capabilities/index.js';
import { operatorDomain } from '../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../marketplace-mcp/marketplace-capabilities.js';
import { capabilitiesDomain } from './capabilities-domain.js';

/**
 * Compose the whole DorkOS capability registry from whichever domains `deps`
 * enables, then back-write it onto `deps` for the self-description capability.
 *
 * @param deps - The boot-time dependency bag. `operatorDeps` includes the
 *   operator domain; `marketplaceDeps` includes the marketplace domain; the
 *   self-description domain is always included. The composed registry is written
 *   back onto `deps.registry`.
 * @returns The frozen, ready-to-serve registry.
 */
export function composeDorkOsCapabilityRegistry(deps: CapabilityDeps): CapabilityRegistry {
  const domains: CapabilityDomain[] = [];
  if (deps.operatorDeps) domains.push(operatorDomain);
  if (deps.marketplaceDeps) domains.push(marketplaceDomain);
  domains.push(capabilitiesDomain);

  const registry = composeRegistry(domains, deps);
  // Back-write the composed registry so `capabilities.list` can serialize it.
  // Done immediately after composition, before any request is served — this is
  // the late-binding half of the self-reference.
  deps.registry = registry;
  return registry;
}
