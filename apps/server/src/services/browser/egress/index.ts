/** Private canonical destination policy; no broker, app route or production activation.
 * @module services/browser/egress
 */
export { createEgressPolicy, type DestinationDecision, type PinnedEndpoint } from './policy.js';
export {
  parseDestination,
  parseConnectAuthority,
  type CanonicalDestination,
} from './destination.js';
export { classifyAddress, type NumericAddress } from './addresses.js';
export { EgressPolicyError, type EgressPolicyCode } from './errors.js';
export { type EgressPolicyOptions, type EgressBinding } from './settings.js';
export { type LocalDestinationGrant } from './grants.js';
export { type DestinationResolver, type DnsObservation } from './resolution.js';
