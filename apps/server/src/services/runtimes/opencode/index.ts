/**
 * OpenCode Runtime — encapsulates all @opencode-ai/sdk interactions.
 *
 * @module services/runtimes/opencode
 */
export { OpenCodeRuntime, type OpenCodeRuntimeOptions } from './opencode-runtime.js';
export {
  OpenCodeServerManager,
  openCodeServerManager,
  OPENCODE_SIDECAR_CONFIG,
} from './server-manager.js';
export {
  OpenCodeSessionMapper,
  type OpenCodeClientProvider,
  type OpenCodeSessionMapStore,
} from './sessions/session-mapper.js';
export { OpenCodeSessionMap } from './sessions/session-map.js';
export { checkOpenCodeDependencies } from './providers/check-dependencies.js';
export { OPENCODE_CAPABILITIES } from './runtime-constants.js';
