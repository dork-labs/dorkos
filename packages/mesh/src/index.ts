/**
 * @dorkos/mesh -- Agent discovery, registration, and registry for DorkOS.
 *
 * Provides pluggable discovery strategies, SQLite-backed persistence,
 * manifest management, and optional Relay integration.
 *
 * @module mesh
 */

// Main entry point
export { MeshCore } from './mesh-core.js';
export type { MeshOptions } from './mesh-core.js';

// Discovery
export type { DiscoveryStrategy } from './discovery-strategy.js';
export { scanDirectory, EXCLUDED_DIRS } from './discovery-engine.js';
export type { DiscoveryOptions, AutoImportedAgent, RegistryLike, DenialListLike } from './discovery-engine.js';

// Strategies
export { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
export { CursorStrategy } from './strategies/cursor-strategy.js';
export { CodexStrategy } from './strategies/codex-strategy.js';

// Persistence
export { AgentRegistry } from './agent-registry.js';
export type { AgentRegistryEntry } from './agent-registry.js';
export { DenialList } from './denial-list.js';

// Manifest
export { readManifest, writeManifest } from './manifest.js';

// Relay Bridge
export { RelayBridge } from './relay-bridge.js';
