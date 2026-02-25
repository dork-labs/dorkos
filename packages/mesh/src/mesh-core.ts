/**
 * MeshCore — main entry point for the @dorkos/mesh package.
 *
 * Composes the discovery engine, agent registry, denial list, manifest
 * reader/writer, and optional Relay bridge into a single cohesive API
 * for agent discovery, registration, and lifecycle management.
 *
 * @module mesh/mesh-core
 */
import { mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { monotonicFactory } from 'ulidx';
import type {
  AgentManifest,
  AgentRuntime,
  AgentHealth,
  AgentHealthStatus,
  DenialRecord,
  DiscoveryCandidate,
  MeshInspect,
  MeshStatus,
} from '@dorkos/shared/mesh-schemas';
import type { RelayCore, SignalEmitter } from '@dorkos/relay';
import type { DiscoveryStrategy } from './discovery-strategy.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentRegistryEntry } from './agent-registry.js';
import { DenialList } from './denial-list.js';
import { RelayBridge } from './relay-bridge.js';
import { TopologyManager } from './topology.js';
import type { TopologyView, CrossNamespaceRule } from './topology.js';
import { resolveNamespace } from './namespace-resolver.js';
import { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
import { CursorStrategy } from './strategies/cursor-strategy.js';
import { CodexStrategy } from './strategies/codex-strategy.js';
import { scanDirectory } from './discovery-engine.js';
import type { DiscoveryOptions } from './discovery-engine.js';
import { readManifest, writeManifest } from './manifest.js';

/** Default data directory for Mesh state. */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dork', 'mesh');

/** Default registrar identifier when none is provided. */
const DEFAULT_REGISTRAR = 'mesh';

// === Types ===

/** Options for creating a MeshCore instance. */
export interface MeshOptions {
  /** Directory for mesh.db and other persisted state. Default: ~/.dork/mesh */
  dataDir?: string;
  /** Optional RelayCore for automatic endpoint registration. */
  relayCore?: RelayCore;
  /** Discovery strategies. Default: [ClaudeCodeStrategy, CursorStrategy, CodexStrategy]. */
  strategies?: DiscoveryStrategy[];
  /** Default scan root for namespace derivation. */
  defaultScanRoot?: string;
  /** Optional SignalEmitter for lifecycle event broadcasting (graceful no-op when absent). */
  signalEmitter?: SignalEmitter;
}

// === MeshCore ===

/**
 * Unified entry point for the Mesh agent discovery and registry system.
 *
 * Composes discovery strategies, SQLite-backed persistence, manifest I/O,
 * and optional Relay endpoint registration into a high-level lifecycle API.
 *
 * @example
 * ```typescript
 * const mesh = new MeshCore({ dataDir: '/tmp/mesh-test' });
 *
 * // Discover agents
 * for await (const candidate of mesh.discover(['/projects'])) {
 *   const manifest = await mesh.register(candidate);
 *   console.log('Registered:', manifest.name);
 * }
 *
 * // List all agents
 * const agents = mesh.list();
 *
 * mesh.close();
 * ```
 */
export class MeshCore {
  private readonly registry: AgentRegistry;
  private readonly denialList: DenialList;
  private readonly relayBridge: RelayBridge;
  private readonly topology: TopologyManager;
  private readonly strategies: DiscoveryStrategy[];
  private readonly defaultScanRoot: string;
  private readonly signalEmitter: SignalEmitter | undefined;
  private readonly generateUlid = monotonicFactory();

  /**
   * Create a new MeshCore instance.
   *
   * @param options - Configuration options
   */
  constructor(options: MeshOptions = {}) {
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    const dbPath = path.join(dataDir, 'mesh.db');

    // Ensure data directory exists before better-sqlite3 opens the DB file
    mkdirSync(dataDir, { recursive: true });

    this.registry = new AgentRegistry(dbPath);
    this.denialList = new DenialList(this.registry.database);
    this.relayBridge = new RelayBridge(options.relayCore, options.signalEmitter);
    this.topology = new TopologyManager(this.registry, this.relayBridge, options.relayCore);
    this.defaultScanRoot = options.defaultScanRoot ?? os.homedir();
    this.signalEmitter = options.signalEmitter;
    this.strategies = options.strategies ?? [
      new ClaudeCodeStrategy(),
      new CursorStrategy(),
      new CodexStrategy(),
    ];
  }

  // --- Discovery ---

  /**
   * Scan root directories for agent candidates.
   *
   * Directories with an existing `.dork/agent.json` are auto-imported
   * into the registry without appearing as candidates. Already-registered
   * and denied paths are skipped automatically.
   *
   * @param roots - Root directories to scan
   * @param options - Scan configuration (maxDepth, excludedDirs, followSymlinks)
   * @returns Async generator of new DiscoveryCandidate objects
   */
  async *discover(
    roots: string[],
    options?: DiscoveryOptions,
  ): AsyncGenerator<DiscoveryCandidate> {
    for (const root of roots) {
      for await (const event of scanDirectory(
        root,
        this.strategies,
        this.registry,
        this.denialList,
        options,
      )) {
        if ('type' in event && event.type === 'auto-import') {
          // Auto-import: upsert into registry if not already there
          await this.upsertAutoImported(event.manifest, event.path);
        } else if (!('type' in event)) {
          // New candidate — yield to caller for approval
          yield event;
        }
      }
    }
  }

  // --- Registration ---

  /**
   * Register a discovered candidate as a full agent.
   *
   * Generates a ULID, merges candidate hints with optional overrides,
   * writes `.dork/agent.json`, inserts into the registry, and registers
   * a Relay endpoint if RelayCore is available.
   *
   * @param candidate - A DiscoveryCandidate yielded from discover()
   * @param overrides - Optional manifest field overrides
   * @param approver - Identifier of the entity approving registration (default: "mesh")
   * @param scanRoot - Root directory for namespace derivation (default: options.defaultScanRoot)
   * @returns The created AgentManifest
   */
  async register(
    candidate: DiscoveryCandidate,
    overrides?: Partial<AgentManifest>,
    approver = DEFAULT_REGISTRAR,
    scanRoot?: string,
  ): Promise<AgentManifest> {
    const id = this.generateUlid();
    const now = new Date().toISOString();
    const effectiveScanRoot = scanRoot ?? this.defaultScanRoot;
    const namespace = resolveNamespace(candidate.path, effectiveScanRoot, overrides?.namespace);

    const manifest: AgentManifest = {
      id,
      name: overrides?.name ?? candidate.hints.suggestedName,
      description: overrides?.description ?? candidate.hints.description ?? '',
      runtime: overrides?.runtime ?? candidate.hints.detectedRuntime,
      capabilities: overrides?.capabilities ?? candidate.hints.inferredCapabilities ?? [],
      behavior: overrides?.behavior ?? { responseMode: 'always' },
      budget: overrides?.budget ?? { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      namespace,
      registeredAt: overrides?.registeredAt ?? now,
      registeredBy: overrides?.registeredBy ?? approver,
    };

    await writeManifest(candidate.path, manifest);

    const entry: AgentRegistryEntry = {
      ...manifest,
      projectPath: candidate.path,
      namespace,
      scanRoot: effectiveScanRoot,
    };
    this.registry.insert(entry);

    await this.relayBridge.registerAgent(manifest, candidate.path, namespace, effectiveScanRoot);

    return manifest;
  }

  /**
   * Register an agent directly by project path without prior discovery.
   *
   * @param projectPath - Absolute path to the agent's project directory
   * @param partial - Manifest fields to set (name, runtime are required)
   * @param approver - Identifier of the entity approving registration (default: "mesh")
   * @param scanRoot - Root directory for namespace derivation (default: options.defaultScanRoot)
   * @returns The created AgentManifest
   */
  async registerByPath(
    projectPath: string,
    partial: Partial<AgentManifest> & { name: string; runtime: AgentRuntime },
    approver = DEFAULT_REGISTRAR,
    scanRoot?: string,
  ): Promise<AgentManifest> {
    const id = this.generateUlid();
    const now = new Date().toISOString();
    const effectiveScanRoot = scanRoot ?? this.defaultScanRoot;
    const namespace = resolveNamespace(projectPath, effectiveScanRoot, partial.namespace);

    const manifest: AgentManifest = {
      id,
      name: partial.name,
      description: partial.description ?? '',
      runtime: partial.runtime,
      capabilities: partial.capabilities ?? [],
      behavior: partial.behavior ?? { responseMode: 'always' },
      budget: partial.budget ?? { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      namespace,
      registeredAt: partial.registeredAt ?? now,
      registeredBy: partial.registeredBy ?? approver,
    };

    await writeManifest(projectPath, manifest);

    const entry: AgentRegistryEntry = {
      ...manifest,
      projectPath,
      namespace,
      scanRoot: effectiveScanRoot,
    };
    this.registry.insert(entry);

    await this.relayBridge.registerAgent(manifest, projectPath, namespace, effectiveScanRoot);

    return manifest;
  }

  // --- Denial ---

  /**
   * Add a project path to the denial list.
   *
   * Denied paths are filtered from future discovery scans.
   *
   * @param filePath - Absolute path to the project directory to deny
   * @param reason - Human-readable reason for denial (optional)
   * @param denier - Identifier of the entity performing the denial (default: "mesh")
   */
  async deny(filePath: string, reason?: string, denier = DEFAULT_REGISTRAR): Promise<void> {
    this.denialList.deny(filePath, 'manual', reason, denier);
  }

  /**
   * Remove a project path from the denial list.
   *
   * @param filePath - Absolute path to clear from the denial list
   */
  async undeny(filePath: string): Promise<void> {
    this.denialList.clear(filePath);
  }

  // --- Listing Denials ---

  /**
   * List all denial records.
   *
   * @returns All denials ordered by denial date (newest first)
   */
  listDenied(): DenialRecord[] {
    return this.denialList.list();
  }

  // --- Update ---

  /**
   * Update mutable fields of a registered agent.
   *
   * @param agentId - The agent's ULID
   * @param partial - Fields to update (name, description, capabilities, etc.)
   * @returns The updated agent manifest, or undefined if not found
   */
  update(agentId: string, partial: Partial<AgentManifest>): AgentManifest | undefined {
    const updated = this.registry.update(agentId, partial);
    if (!updated) return undefined;
    const entry = this.registry.get(agentId);
    if (!entry) return undefined;
    const { projectPath: _p, namespace: _n, scanRoot: _s, ...manifest } = entry;
    return manifest;
  }

  // --- Unregistration ---

  /**
   * Unregister an agent by ID.
   *
   * Removes from the registry and unregisters the Relay endpoint.
   * Does NOT delete the `.dork/agent.json` file from disk.
   *
   * @param agentId - The ULID of the agent to unregister
   */
  async unregister(agentId: string): Promise<void> {
    const agent = this.registry.get(agentId);
    if (!agent) return;

    const namespace = agent.namespace;
    // Use namespace for subject when available, fall back to project basename
    const subject = `relay.agent.${namespace || path.basename(agent.projectPath)}.${agent.id}`;
    await this.relayBridge.unregisterAgent(subject, agent.id, agent.name);

    this.registry.remove(agentId);

    // Clean up namespace rules if this was the last agent in the namespace
    if (namespace) {
      const remaining = this.registry.listByNamespace(namespace);
      if (remaining.length === 0) {
        this.relayBridge.cleanupNamespaceRules(namespace);
      }
    }
  }

  // --- Query ---

  /**
   * List all registered agents, optionally filtered by runtime or capability.
   *
   * When `callerNamespace` is provided, uses TopologyManager for namespace-scoped
   * filtering with invisible boundary enforcement. Pass '*' for admin view.
   *
   * @param filters - Optional runtime, capability, and/or callerNamespace filters
   * @returns Array of agent manifests (projectPath stripped for public API)
   */
  list(filters?: { runtime?: AgentRuntime; capability?: string; callerNamespace?: string }): AgentManifest[] {
    if (filters?.callerNamespace) {
      // Delegate to TopologyManager for namespace-scoped visibility
      const view = this.topology.getTopology(filters.callerNamespace);
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

    const entries = this.registry.list(filters);
    return entries.map(({ projectPath: _p, namespace: _n, scanRoot: _s, ...manifest }) => manifest);
  }

  /**
   * Get an agent manifest by ULID.
   *
   * @param agentId - The agent's ULID
   * @returns The agent manifest, or undefined if not found
   */
  get(agentId: string): AgentManifest | undefined {
    const entry = this.registry.get(agentId);
    if (!entry) return undefined;
    const { projectPath: _p, namespace: _n, scanRoot: _s, ...manifest } = entry;
    return manifest;
  }

  /**
   * Get an agent manifest by project path.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns The agent manifest, or undefined if not found
   */
  getByPath(projectPath: string): AgentManifest | undefined {
    const entry = this.registry.getByPath(projectPath);
    if (!entry) return undefined;
    const { projectPath: _p, namespace: _n, scanRoot: _s, ...manifest } = entry;
    return manifest;
  }

  // --- Topology ---

  /**
   * Get the topology view filtered by caller's namespace access.
   *
   * @param callerNamespace - The namespace of the requesting agent, or '*' for admin view
   * @returns Topology view with accessible namespaces and cross-namespace rules
   */
  getTopology(callerNamespace: string): TopologyView {
    return this.topology.getTopology(callerNamespace);
  }

  /**
   * Get which agents a specific agent can reach.
   *
   * @param agentId - The ULID of the agent
   * @returns Array of reachable agent manifests, or undefined if agent not found
   */
  getAgentAccess(agentId: string): AgentManifest[] | undefined {
    return this.topology.getAgentAccess(agentId);
  }

  /**
   * Add a cross-namespace allow rule via Relay access control.
   *
   * @param sourceNamespace - The namespace to allow messages from
   * @param targetNamespace - The namespace to allow messages to
   */
  allowCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    this.topology.allowCrossNamespace(sourceNamespace, targetNamespace);
  }

  /**
   * Remove a cross-namespace allow rule (reverts to default-deny).
   *
   * @param sourceNamespace - Source namespace
   * @param targetNamespace - Target namespace
   */
  denyCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    this.topology.denyCrossNamespace(sourceNamespace, targetNamespace);
  }

  /**
   * List all cross-namespace access rules.
   *
   * @returns Array of cross-namespace rules extracted from Relay access control
   */
  listCrossNamespaceRules(): CrossNamespaceRule[] {
    return this.topology.listCrossNamespaceRules();
  }

  // --- Health & Observability ---

  /**
   * Update the last-seen timestamp and event for an agent.
   *
   * Captures the previous health status before the update and emits a
   * `mesh.agent.lifecycle.health_changed` signal via the SignalEmitter if
   * the status transitions (e.g. stale → active). When no SignalEmitter is
   * configured the update still persists; signal emission is skipped silently.
   *
   * @param agentId - The agent's ULID
   * @param event - Description of the triggering event (e.g. 'heartbeat', 'message_sent')
   */
  updateLastSeen(agentId: string, event: string): void {
    const before = this.registry.getWithHealth(agentId);
    const previousStatus: AgentHealthStatus | undefined = before?.healthStatus;

    this.registry.updateHealth(agentId, new Date().toISOString(), event);

    if (this.signalEmitter && before !== undefined && previousStatus !== undefined) {
      const after = this.registry.getWithHealth(agentId);
      const currentStatus = after?.healthStatus;
      if (currentStatus !== undefined && previousStatus !== currentStatus) {
        const subject = 'mesh.agent.lifecycle.health_changed';
        this.signalEmitter.emit(subject, {
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
   * @param agentId - The agent's ULID
   * @returns AgentHealth snapshot, or undefined if the agent is not found
   */
  getAgentHealth(agentId: string): AgentHealth | undefined {
    const entry = this.registry.getWithHealth(agentId);
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
   * Get aggregate mesh status — counts by health status plus runtime and project groupings.
   *
   * @returns MeshStatus snapshot with live counts and groupings
   */
  getStatus(): MeshStatus {
    const stats = this.registry.getAggregateStats();
    const agents = this.registry.listWithHealth();

    const byRuntime: Record<string, number> = {};
    const byProject: Record<string, number> = {};

    for (const agent of agents) {
      byRuntime[agent.runtime] = (byRuntime[agent.runtime] ?? 0) + 1;
      const project = agent.projectPath || 'unknown';
      byProject[project] = (byProject[project] ?? 0) + 1;
    }

    return {
      totalAgents: stats.totalAgents,
      activeCount: stats.activeCount,
      inactiveCount: stats.inactiveCount,
      staleCount: stats.staleCount,
      byRuntime,
      byProject,
    };
  }

  /**
   * Get a detailed inspection of a single agent combining manifest, health, and relay info.
   *
   * @param agentId - The agent's ULID
   * @returns MeshInspect snapshot, or undefined if the agent is not found
   */
  inspect(agentId: string): MeshInspect | undefined {
    const entry = this.registry.get(agentId);
    if (!entry) return undefined;

    const health = this.getAgentHealth(agentId);
    if (!health) return undefined;

    const { projectPath, namespace, scanRoot: _s, ...manifest } = entry;

    // Derive relay subject using the same pattern as registration
    const ns = namespace || path.basename(projectPath);
    const relaySubject = `relay.agent.${ns}.${agentId}`;

    return { agent: manifest, health, relaySubject };
  }

  /** Close the database connection. */
  close(): void {
    this.registry.close();
  }

  // --- Private helpers ---

  /**
   * Upsert an auto-imported agent manifest into the registry.
   *
   * If the agent is already registered (same path), it is skipped.
   * Otherwise it is inserted and a Relay endpoint is registered.
   */
  private async upsertAutoImported(manifest: AgentManifest, projectPath: string): Promise<void> {
    // Skip if already registered at this path
    if (this.registry.getByPath(projectPath)) return;

    const namespace = manifest.namespace ?? '';
    const entry: AgentRegistryEntry = {
      ...manifest,
      projectPath,
      namespace,
      scanRoot: this.defaultScanRoot,
    };
    this.registry.insert(entry);
    await this.relayBridge.registerAgent(manifest, projectPath, namespace, this.defaultScanRoot);
  }

}
