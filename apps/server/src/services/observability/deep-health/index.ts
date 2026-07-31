/**
 * Deep health checks — the part of `dorkos doctor` that needs a running server.
 *
 * @module services/observability/deep-health
 */
export {
  checkAdapterEntries,
  checkDuplicateAgentIds,
  checkRelayAccessRules,
  checkRelayBindingGhosts,
  checkRoomSessionTranscripts,
  type AgentManifestLocation,
  type RelayBinding,
  type RoomSessionBinding,
} from './checks.js';
export {
  collectAgentManifests,
  collectTranscriptSessionIds,
  listAgentHomeDirectories,
} from './collect.js';
export { runDeepHealthChecks, type DeepHealthDeps } from './run.js';
