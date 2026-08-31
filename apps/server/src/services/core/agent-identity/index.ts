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
  createInSessionContextResolver,
  AGENT_TOKEN_ENV_VAR,
} from './agent-token-env.js';
export { createCapabilityAttributionObserver } from './capability-attribution.js';
export { createCapabilityGateAuditObserver } from './capability-gate-audit.js';
export { createAgentIdentityUnregisterCascade } from './unregister-cascade.js';
