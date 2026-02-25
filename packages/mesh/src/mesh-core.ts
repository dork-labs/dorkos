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
import type { AgentManifest, AgentRuntime, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import type { RelayCore } from '@dorkos/relay';
import type { DiscoveryStrategy } from './discovery-strategy.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentRegistryEntry } from './agent-registry.js';
import { DenialList } from './denial-list.js';
import { RelayBridge } from './relay-bridge.js';
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
  private readonly strategies: DiscoveryStrategy[];
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
    this.relayBridge = new RelayBridge(options.relayCore);
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
   * @returns The created AgentManifest
   */
  async register(
    candidate: DiscoveryCandidate,
    overrides?: Partial<AgentManifest>,
    approver = DEFAULT_REGISTRAR,
  ): Promise<AgentManifest> {
    const id = this.generateUlid();
    const now = new Date().toISOString();

    const manifest: AgentManifest = {
      id,
      name: overrides?.name ?? candidate.hints.suggestedName,
      description: overrides?.description ?? candidate.hints.description ?? '',
      runtime: overrides?.runtime ?? candidate.hints.detectedRuntime,
      capabilities: overrides?.capabilities ?? candidate.hints.inferredCapabilities ?? [],
      behavior: overrides?.behavior ?? { responseMode: 'always' },
      budget: overrides?.budget ?? { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      registeredAt: overrides?.registeredAt ?? now,
      registeredBy: overrides?.registeredBy ?? approver,
    };

    await writeManifest(candidate.path, manifest);

    const entry: AgentRegistryEntry = { ...manifest, projectPath: candidate.path };
    this.registry.insert(entry);

    await this.relayBridge.registerAgent(manifest, candidate.path);

    return manifest;
  }

  /**
   * Register an agent directly by project path without prior discovery.
   *
   * @param projectPath - Absolute path to the agent's project directory
   * @param partial - Manifest fields to set (name, runtime are required)
   * @param approver - Identifier of the entity approving registration (default: "mesh")
   * @returns The created AgentManifest
   */
  async registerByPath(
    projectPath: string,
    partial: Partial<AgentManifest> & { name: string; runtime: AgentRuntime },
    approver = DEFAULT_REGISTRAR,
  ): Promise<AgentManifest> {
    const id = this.generateUlid();
    const now = new Date().toISOString();

    const manifest: AgentManifest = {
      id,
      name: partial.name,
      description: partial.description ?? '',
      runtime: partial.runtime,
      capabilities: partial.capabilities ?? [],
      behavior: partial.behavior ?? { responseMode: 'always' },
      budget: partial.budget ?? { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      registeredAt: partial.registeredAt ?? now,
      registeredBy: partial.registeredBy ?? approver,
    };

    await writeManifest(projectPath, manifest);

    const entry: AgentRegistryEntry = { ...manifest, projectPath };
    this.registry.insert(entry);

    await this.relayBridge.registerAgent(manifest, projectPath);

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

    // Derive the subject that was registered in Relay
    const subject = `relay.agent.${path.basename(agent.projectPath)}.${agent.id}`;
    await this.relayBridge.unregisterAgent(subject);

    this.registry.remove(agentId);
  }

  // --- Query ---

  /**
   * List all registered agents, optionally filtered by runtime or capability.
   *
   * @param filters - Optional runtime and/or capability filters
   * @returns Array of agent manifests (projectPath stripped for public API)
   */
  list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentManifest[] {
    return this.registry.list(filters).map(({ projectPath: _path, ...manifest }) => manifest);
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
    const { projectPath: _path, ...manifest } = entry;
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
    const { projectPath: _path, ...manifest } = entry;
    return manifest;
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

    const entry: AgentRegistryEntry = { ...manifest, projectPath };
    this.registry.insert(entry);
    await this.relayBridge.registerAgent(manifest, projectPath);
  }
}
