/**
 * Per-agent identity: minted tokens, resolution, and Activity attribution
 * (spec `agent-trust` §3.1).
 *
 * @module services/core/agent-identity
 */
export {
  AgentIdentityService,
  agentTokenDigestPrefix,
  initAgentIdentityService,
  getAgentIdentityService,
  resetAgentIdentityService,
  TOKEN_ABSOLUTE_TTL_MS,
  TOKEN_IDLE_TTL_MS,
  type AgentIdentity,
  type MintAgentTokenInput,
} from './agent-identity-service.js';
export {
  resolveAgentTokenEnv,
  ensureInSessionAgentIdentity,
  createInSessionContextResolver,
  AGENT_TOKEN_ENV_VAR,
} from './agent-token-env.js';
export {
  resolveAgentHome,
  canonicalDir,
  homeOf,
  turnAgentOf,
  readHomeManifest,
  setAgentHomeRegistry,
  assertOwnDesk,
  assertNobodysDesk,
  isInsideRoomsDir,
  deskBindingFor,
  DeskNotOwnError,
  type AgentHome,
  type AgentHomeRegistry,
  type DeskBinding,
  type HomeResolution,
  type HomeVia,
} from './agent-home.js';
export { createCapabilityAttributionObserver } from './capability-attribution.js';
export { createCapabilityGateAuditObserver } from './capability-gate-audit.js';
export { createAgentIdentityUnregisterCascade } from './unregister-cascade.js';
