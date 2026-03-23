/**
 * A2A-specific TypeScript types for the gateway package.
 *
 * Defines configuration interfaces used by the Agent Card generator
 * and the DorkOS Agent Executor that bridges A2A requests to Relay.
 *
 * @module a2a-gateway/types
 */
import type { RelayCore } from '@dorkos/relay';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Configuration for Agent Card generation. */
export interface CardGeneratorConfig {
  /** Base URL where the DorkOS server is accessible (e.g., "https://dorkos.example.com"). */
  baseUrl: string;
  /** DorkOS version string for the Agent Card version field. */
  version: string;
}

/**
 * Minimal registry interface for agent lookup.
 *
 * Satisfied by both `MeshCore` and `AgentRegistry` from `@dorkos/mesh`,
 * allowing the executor to accept either without a concrete dependency.
 */
export interface AgentRegistryLike {
  /** Look up an agent by ULID. */
  get(id: string): AgentManifest | undefined;
  /** List all registered agents. */
  list(): AgentManifest[];
}

/** Dependencies injected into the DorkOS A2A executor. */
export interface ExecutorDeps {
  /** Relay core instance for publishing messages and subscribing to responses. */
  relay: RelayCore;
  /** Agent registry (or MeshCore) for resolving target agents. */
  agentRegistry: AgentRegistryLike;
}
