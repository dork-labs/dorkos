/**
 * Agent management operations extracted from MeshCore.
 *
 * Contains list/get/update/unregister operations, health & observability
 * methods, status snapshots, and agent inspection.
 *
 * @module mesh/mesh-agent-management
 */
import path from 'path';
import type {
  AgentManifest,
  AgentRuntime,
  AgentHealth,
  AgentHealthStatus,
  MeshInspect,
  MeshStatus,
} from '@dorkos/shared/mesh-schemas';
import type { SignalEmitter } from '@dorkos/relay';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { RelayBridge } from './relay-bridge.js';
import type { TopologyManager, TopologyView, CrossNamespaceRule } from './topology.js';
import { readManifest, writeManifest, removeManifest } from './manifest.js';
import type { DiscoveryDeps } from './mesh-discovery.js';
import { upsertAutoImported } from './mesh-discovery.js';

/** Dependencies required by agent management functions. */
export interface AgentManagementDeps {
  registry: AgentRegistry;
  relayBridge: RelayBridge;
  topology: TopologyManager;
  signalEmitter: SignalEmitter | undefined;
  logger: import('@dorkos/shared/logger').Logger;
  onUnregisterCallbacks: Array<(agentId: string) => void>;
}

/**
 * Strip internal registry fields (projectPath, namespace, scanRoot) from an entry.
 *
 * Works with both plain AgentRegistryEntry and health-enriched entries,
 * preserving any additional fields (healthStatus, lastSeenAt, etc.).
 *
 * @param entry - Registry entry with internal fields
 * @returns Clean object with internal fields removed
 */
export function toManifest<T extends AgentRegistryEntry>(
  entry: T
): Omit<T, 'projectPath' | 'namespace' | 'scanRoot'> {
  const { projectPath: _p, namespace: _n, scanRoot: _s, ...rest } = entry;
  return rest;
}

/**
 * List all registered agents, optionally filtered by runtime or capability.
 *
 * When `callerNamespace` is provided, uses TopologyManager for namespace-scoped
 * filtering with invisible boundary enforcement. Pass '*' for admin view.
 *
 * @param deps - Agent management dependencies
 * @param filters - Optional runtime, capability, and/or callerNamespace filters
 * @returns Array of agent manifests (projectPath stripped for public API)
 */
export function list(
  deps: AgentManagementDeps,
  filters?: { runtime?: AgentRuntime; capability?: string; callerNamespace?: string }
): AgentManifest[] {
  if (filters?.callerNamespace) {
    // Delegate to TopologyManager for namespace-scoped visibility
    const view = deps.topology.getTopology(filters.callerNamespace);
    let agents = view.namespaces.flatMap((ns) => ns.agents);

    // Apply runtime/capability filters on top of topology filtering
    if (filters.runtime) {
      agents = agents.filter((a) => a.runtime === filters.runtime);
    }
    if (filters.capability) {
      agents = agents.filter((a) => a.capabilities.includes(filters.capability!));
    }
    return agents;
  }

  const entries = deps.registry.list(filters);
  return entries.map((entry) => toManifest(entry));
}

/**
 * List agents with computed health status included.
 *
 * Returns the same data as `list()` but each entry includes `healthStatus`,
 * `lastSeenAt`, and `lastSeenEvent` fields for topology visualization.
 *
 * @param deps - Agent management dependencies
 * @param filters - Optional runtime or capability filters
 * @returns Array of agent manifests with health fields
 */
export function listWithHealth(
  deps: AgentManagementDeps,
  filters?: { runtime?: AgentRuntime; capability?: string }
): (AgentManifest & {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
})[] {
  const entries = deps.registry.listWithHealth(filters);
  return entries.map((entry) => toManifest(entry));
}

/**
 * List registered agents with their project paths (lightweight view for onboarding/scheduling).
 *
 * Unlike `list()` which strips `projectPath`, this returns it so the client
 * can target schedules at specific agent working directories.
 *
 * @param deps - Agent management dependencies
 * @returns Array of lightweight agent entries with project paths
 */
export function listWithPaths(
  deps: AgentManagementDeps
): Array<{ id: string; name: string; projectPath: string; icon?: string; color?: string }> {
  return deps.registry.list().map((e) => ({
    id: e.id,
    name: e.name,
    projectPath: e.projectPath,
    icon: e.icon,
    color: e.color,
  }));
}

/**
 * Get an agent manifest by ULID.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @returns The agent manifest, or undefined if not found
 */
export function get(deps: AgentManagementDeps, agentId: string): AgentManifest | undefined {
  const entry = deps.registry.get(agentId);
  if (!entry) return undefined;
  return toManifest(entry);
}

/**
 * Get an agent manifest by project path.
 *
 * @param deps - Agent management dependencies
 * @param projectPath - Absolute path to the project directory
 * @returns The agent manifest, or undefined if not found
 */
export function getByPath(
  deps: AgentManagementDeps,
  projectPath: string
): AgentManifest | undefined {
  const entry = deps.registry.getByPath(projectPath);
  if (!entry) return undefined;
  return toManifest(entry);
}

/**
 * Get the project path for a registered agent.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @returns The absolute project path, or undefined if not found
 */
export function getProjectPath(deps: AgentManagementDeps, agentId: string): string | undefined {
  const entry = deps.registry.get(agentId);
  return entry?.projectPath;
}

/**
 * Update mutable fields of a registered agent.
 *
 * ADR-0043: writes to `.dork/agent.json` first (canonical), then updates DB (cache).
 * If the manifest file is missing, reconstructs from the DB entry before writing.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @param partial - Fields to update (name, description, capabilities, etc.)
 * @returns The updated agent manifest, or undefined if not found
 */
export async function update(
  deps: AgentManagementDeps,
  agentId: string,
  partial: Partial<AgentManifest>
): Promise<AgentManifest | undefined> {
  const entry = deps.registry.get(agentId);
  if (!entry) return undefined;

  // ADR-0043: read current manifest from disk, merge, write back
  const diskManifest = await readManifest(entry.projectPath);
  const base = diskManifest ?? toManifest(entry);
  const merged: AgentManifest = { ...base, ...partial, id: agentId };
  await writeManifest(entry.projectPath, merged);

  // Then update DB cache
  deps.registry.update(agentId, partial);
  const updatedEntry = deps.registry.get(agentId);
  if (!updatedEntry) return undefined;
  return toManifest(updatedEntry);
}

/**
 * Unregister an agent by ID.
 *
 * ADR-0043: deletes `.dork/agent.json` from disk, removes from the registry,
 * and unregisters the Relay endpoint. Without file deletion, unregistered
 * agents silently reappear on the next discovery scan.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The ULID of the agent to unregister
 */
export async function unregister(deps: AgentManagementDeps, agentId: string): Promise<void> {
  const agent = deps.registry.get(agentId);
  if (!agent) return;

  // ADR-0043: delete manifest file first to prevent re-discovery
  await removeManifest(agent.projectPath);

  const namespace = agent.namespace;
  // Use namespace for subject when available, fall back to project basename
  const subject = `relay.agent.${namespace || path.basename(agent.projectPath)}.${agent.id}`;
  await deps.relayBridge.unregisterAgent(subject, agent.id, agent.name);

  deps.registry.remove(agentId);

  // Fire unregister callbacks (e.g., cascade-disable Pulse schedules)
  for (const cb of deps.onUnregisterCallbacks) {
    try {
      cb(agentId);
    } catch (err) {
      deps.logger.warn('[Mesh] Unregister callback failed', { agentId, err });
    }
  }

  // Clean up namespace rules if this was the last agent in the namespace
  if (namespace) {
    const remaining = deps.registry.listByNamespace(namespace);
    if (remaining.length === 0) {
      deps.relayBridge.cleanupNamespaceRules(namespace);
    }
  }
}

/**
 * Sync a single agent from its `.dork/agent.json` file into the DB.
 *
 * ADR-0043: enables immediate file-to-DB sync without waiting for the
 * 5-minute periodic reconciler. Reuses the auto-import upsert pipeline.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param discoveryDeps - Discovery dependencies (needed for upsertAutoImported)
 * @returns true if the manifest was found and synced, false otherwise
 */
export async function syncFromDisk(
  projectPath: string,
  discoveryDeps: DiscoveryDeps
): Promise<boolean> {
  const manifest = await readManifest(projectPath);
  if (!manifest) return false;
  await upsertAutoImported(manifest, projectPath, discoveryDeps);
  return true;
}

// --- Health & Observability ---

/**
 * Update the last-seen timestamp and event for an agent.
 *
 * Captures the previous health status before the update and emits a
 * `mesh.agent.lifecycle.health_changed` signal via the SignalEmitter if
 * the status transitions (e.g. stale to active). When no SignalEmitter is
 * configured the update still persists; signal emission is skipped silently.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @param event - Description of the triggering event (e.g. 'heartbeat', 'message_sent')
 */
export function updateLastSeen(deps: AgentManagementDeps, agentId: string, event: string): void {
  const before = deps.registry.getWithHealth(agentId);
  const previousStatus: AgentHealthStatus | undefined = before?.healthStatus;

  deps.registry.updateHealth(agentId, new Date().toISOString(), event);

  if (deps.signalEmitter && before !== undefined && previousStatus !== undefined) {
    const after = deps.registry.getWithHealth(agentId);
    const currentStatus = after?.healthStatus;
    if (currentStatus !== undefined && previousStatus !== currentStatus) {
      const subject = 'mesh.agent.lifecycle.health_changed';
      deps.signalEmitter.emit(subject, {
        type: 'progress',
        state: 'health_changed',
        endpointSubject: subject,
        timestamp: new Date().toISOString(),
        data: {
          agentId,
          agentName: before.name,
          event: 'health_changed',
          previousStatus,
          currentStatus,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
}

/**
 * Get the health status for a single agent.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @returns AgentHealth snapshot, or undefined if the agent is not found
 */
export function getAgentHealth(
  deps: AgentManagementDeps,
  agentId: string
): AgentHealth | undefined {
  const entry = deps.registry.getWithHealth(agentId);
  if (!entry) return undefined;
  return {
    agentId: entry.id,
    name: entry.name,
    status: entry.healthStatus,
    lastSeenAt: entry.lastSeenAt,
    lastSeenEvent: entry.lastSeenEvent,
    registeredAt: entry.registeredAt,
    runtime: entry.runtime,
    capabilities: entry.capabilities,
  };
}

/**
 * Get aggregate mesh status -- counts by health status plus runtime and project groupings.
 *
 * @param deps - Agent management dependencies
 * @returns MeshStatus snapshot with live counts and groupings
 */
export function getStatus(deps: AgentManagementDeps): MeshStatus {
  // Single DB query -- getAggregateStats() computes health counts,
  // runtime groupings, and project groupings in one pass.
  const stats = deps.registry.getAggregateStats();
  return {
    totalAgents: stats.totalAgents,
    activeCount: stats.activeCount,
    inactiveCount: stats.inactiveCount,
    staleCount: stats.staleCount,
    unreachableCount: stats.unreachableCount,
    byRuntime: stats.byRuntime,
    byProject: stats.byProject,
  };
}

/**
 * Get a detailed inspection of a single agent combining manifest, health, and relay info.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @returns MeshInspect snapshot, or undefined if the agent is not found
 */
export function inspect(deps: AgentManagementDeps, agentId: string): MeshInspect | undefined {
  const entry = deps.registry.get(agentId);
  if (!entry) return undefined;

  const health = getAgentHealth(deps, agentId);
  if (!health) return undefined;

  const manifest = toManifest(entry);

  // Derive relay subject using the same pattern as registration
  const ns = entry.namespace || path.basename(entry.projectPath);
  const relaySubject = `relay.agent.${ns}.${agentId}`;

  return { agent: manifest, health, relaySubject };
}

// --- Topology (delegation) ---

/**
 * Get the topology view filtered by caller's namespace access.
 *
 * @param deps - Agent management dependencies
 * @param callerNamespace - The namespace of the requesting agent, or '*' for admin view
 * @returns Topology view with accessible namespaces and cross-namespace rules
 */
export function getTopology(deps: AgentManagementDeps, callerNamespace: string): TopologyView {
  return deps.topology.getTopology(callerNamespace);
}

/**
 * Get which agents a specific agent can reach.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The ULID of the agent
 * @returns Array of reachable agent manifests, or undefined if agent not found
 */
export function getAgentAccess(
  deps: AgentManagementDeps,
  agentId: string
): AgentManifest[] | undefined {
  return deps.topology.getAgentAccess(agentId);
}

/**
 * Add a cross-namespace allow rule via Relay access control.
 *
 * @param deps - Agent management dependencies
 * @param sourceNamespace - The namespace to allow messages from
 * @param targetNamespace - The namespace to allow messages to
 */
export function allowCrossNamespace(
  deps: AgentManagementDeps,
  sourceNamespace: string,
  targetNamespace: string
): void {
  deps.topology.allowCrossNamespace(sourceNamespace, targetNamespace);
}

/**
 * Remove a cross-namespace allow rule (reverts to default-deny).
 *
 * @param deps - Agent management dependencies
 * @param sourceNamespace - Source namespace
 * @param targetNamespace - Target namespace
 */
export function denyCrossNamespace(
  deps: AgentManagementDeps,
  sourceNamespace: string,
  targetNamespace: string
): void {
  deps.topology.denyCrossNamespace(sourceNamespace, targetNamespace);
}

/**
 * List all cross-namespace access rules.
 *
 * @param deps - Agent management dependencies
 * @returns Array of cross-namespace rules extracted from Relay access control
 */
export function listCrossNamespaceRules(deps: AgentManagementDeps): CrossNamespaceRule[] {
  return deps.topology.listCrossNamespaceRules();
}
