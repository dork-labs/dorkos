/**
 * Per-agent identity: minted tokens, resolution, and Activity attribution
 * (spec `agent-trust` §3.1).
 *
 * @module services/core/agent-identity
 */
export {
  AgentIdentityService,
  initAgentIdentityService,
  getAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentity,
  type MintAgentTokenInput,
} from './agent-identity-service.js';
export { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from './agent-token-env.js';
export { createCapabilityAttributionObserver } from './capability-attribution.js';
