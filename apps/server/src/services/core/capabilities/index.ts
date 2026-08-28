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
  type CapabilityToolGroup,
} from './capability-definition.js';
export {
  // `enforceToolGroupGrant` is deliberately NOT re-exported, for the same reason
  // `enforceCapabilityTier` is not: the gate is reached through `registry.invoke`
  // and there is no second supported caller.
  initToolGroupGate,
  resetToolGroupGate,
  type ToolGroupGateOptions,
  type ToolGroupGrantLookup,
} from './tool-group-enforcement.js';
export { manifestToolGroupGrants } from './tool-group-grants.js';
export {
  composeRegistry,
  serializeCapability,
  computeCatalogVersion,
  type CapabilityRegistry,
  type CapabilityHandlerContext,
  type CapabilityInvocationContext,
  type CapabilityInvocationObserver,
} from './registry.js';
export { isTrustedCaller, trustedCaller, type TrustedCaller } from './trusted-caller.js';
export {
  // `enforceCapabilityTier` is deliberately NOT re-exported: the gate is reached
  // through `registry.invoke`, or through `authorizeCapability` by the one kind of
  // caller that owns its own effect (DOR-467).
  authorizeCapability,
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  splitApprovalToken,
  describeGatedAttempt,
  APPROVAL_TOKEN_ARGUMENT,
  APPROVAL_TOKEN_HEADER,
  type ApprovalRequiredPayload,
  type ApprovalRequiredReason,
  type ApprovalRetryChannel,
  type AutoApprovedAttempt,
  type CapabilityTierGateOptions,
  type GrantedApproval,
  type StandingGrantLookup,
  type TierDeniedPayload,
  type TierDeniedReason,
  type TierEnforcementAttempt,
  type TierEnforcementDecision,
  type TierEnforcementRequest,
} from './tier-enforcement.js';
export { readOnlyCarveOutToolNames } from './mcp-projection.js';
export { registerCapabilitiesInOpenApi } from './openapi-projection.js';
export { CapabilityToolError, unwrapMcpEnvelope, type McpTextEnvelope } from './mcp-envelope.js';
