/**
 * The Capability Registry spine: one typed declaration per capability, folded
 * into an immutable runtime registry every agent-facing surface is generated
 * from (spec `capability-registry`, task 2.1).
 *
 * @module services/core/capabilities
 */
export {
  defineCapability,
  type CapabilityDefinition,
  type CapabilityDeps,
  type CapabilityDomain,
} from './capability-definition.js';
export {
  composeRegistry,
  serializeCapability,
  computeCatalogVersion,
  type CapabilityRegistry,
  type CapabilityInvocationContext,
  type CapabilityInvocationObserver,
} from './registry.js';
export {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  splitApprovalToken,
  describeGatedAttempt,
  APPROVAL_TOKEN_ARGUMENT,
  APPROVAL_TOKEN_HEADER,
  type ApprovalRequiredPayload,
  type ApprovalRequiredReason,
  type ApprovalRetryChannel,
  type CapabilityTierGateOptions,
  type GrantedApproval,
  type TierDeniedPayload,
  type TierDeniedReason,
  type TierEnforcementAttempt,
  type TierEnforcementDecision,
  type TierEnforcementRequest,
} from './tier-enforcement.js';
export { readOnlyCarveOutToolNames } from './mcp-projection.js';
export { registerCapabilitiesInOpenApi } from './openapi-projection.js';
export { CapabilityToolError, unwrapMcpEnvelope, type McpTextEnvelope } from './mcp-envelope.js';
