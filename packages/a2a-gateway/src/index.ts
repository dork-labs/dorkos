/**
 * @dorkos/a2a-gateway -- A2A protocol gateway for DorkOS.
 *
 * Exposes DorkOS agents as A2A-compliant endpoints for cross-vendor
 * agent communication. Generates Agent Cards from the Mesh registry,
 * translates A2A requests to Relay publishes, and persists task state
 * in SQLite.
 *
 * @module a2a-gateway
 */

// Types
export type { AgentRegistryLike, CardGeneratorConfig, ExecutorDeps } from './types.js';

// Agent Card generation
export { generateAgentCard, generateFleetCard } from './agent-card-generator.js';

// Schema translation
export {
  a2aMessageToRelayPayload,
  relayPayloadToA2aMessage,
  relayStatusToTaskState,
} from './schema-translator.js';

// Task persistence
export { SqliteTaskStore } from './task-store.js';

// Agent executor
export { DorkOSAgentExecutor } from './dorkos-executor.js';

// Express integration
export { createA2aHandlers } from './express-handlers.js';
export type { A2aHandlerDeps, A2aHandlers } from './express-handlers.js';
