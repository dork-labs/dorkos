/**
 * Pausing an agent everywhere (spec `audit-trail` PR5): the service, the
 * backstop at the runtime seam, and the capabilities.
 *
 * @module services/mesh/pause
 */
export {
  AgentPauseService,
  AgentPausedError,
  CannotResumeSelfError,
  PauseAgentNotFoundError,
  agentPause,
  initAgentPause,
  resetAgentPause,
  type AgentPauseServiceDeps,
  type HeldVia,
  type PausedAgentRef,
  type TurnAgentOpts,
} from './agent-pause.js';
export { holdPausedAgents } from './hold-paused-turns.js';
export { wireAgentPause } from './wire-agent-pause.js';
export { agentPauseDomain } from './pause-capabilities.js';
