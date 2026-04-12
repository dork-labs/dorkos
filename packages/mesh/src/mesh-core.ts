/**
 * MeshCore — thin coordinator for the @dorkos/mesh package.
 *
 * Composes sub-modules for discovery, agent management, and denial into
 * a single cohesive class API. All business logic lives in the sub-modules;
 * this file wires dependencies and delegates method calls.
 *
 * @module mesh/mesh-core
 */
import os from 'os';
import { monotonicFactory } from 'ulidx';
import type { Db } from '@dorkos/db';
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
import { DenialList } from './denial-list.js';
import { RelayBridge } from './relay-bridge.js';
import { TopologyManager } from './topology.js';
import type { TopologyView, CrossNamespaceRule } from './topology.js';
import type { ScanEvent, UnifiedScanOptions } from './discovery/types.js';
import { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
import { CursorStrategy } from './strategies/cursor-strategy.js';
import { CodexStrategy } from './strategies/codex-strategy.js';
import { WindsurfStrategy } from './strategies/windsurf-strategy.js';
import { GeminiStrategy } from './strategies/gemini-strategy.js';
import { ClineStrategy } from './strategies/cline-strategy.js';
import { RooCodeStrategy } from './strategies/roo-code-strategy.js';
import { CopilotStrategy } from './strategies/copilot-strategy.js';
import { AmazonQStrategy } from './strategies/amazon-q-strategy.js';
import { ContinueStrategy } from './strategies/continue-strategy.js';
import { reconcile } from './reconciler.js';
import type { ReconcileResult } from './reconciler.js';
import * as discovery from './mesh-discovery.js';
import type { DiscoveryDeps } from './mesh-discovery.js';
import * as agentMgmt from './mesh-agent-management.js';
import type { AgentManagementDeps } from './mesh-agent-management.js';
import * as denial from './mesh-denial.js';
import type { DenialDeps } from './mesh-denial.js';

/** Options for creating a MeshCore instance. */
export interface MeshOptions {
  /** Drizzle database instance from @dorkos/db createDb(). */
  db: Db;
  /** Optional RelayCore for automatic endpoint registration. */
  relayCore?: RelayCore;
  /** Discovery strategies. Default: all built-in strategies. */
  strategies?: DiscoveryStrategy[];
  /** Default scan root for namespace derivation. */
  defaultScanRoot?: string;
  /** Optional SignalEmitter for lifecycle event broadcasting (graceful no-op when absent). */
  signalEmitter?: SignalEmitter;
  /** Optional logger for structured output (defaults to console). */
  logger?: import('@dorkos/shared/logger').Logger;
}

/**
 * Unified entry point for the Mesh agent discovery and registry system.
 *
 * Composes discovery strategies, SQLite-backed persistence, manifest I/O,
 * and optional Relay endpoint registration into a high-level lifecycle API.
 */
export class MeshCore {
  private readonly discoveryDeps: DiscoveryDeps;
  private readonly agentDeps: AgentManagementDeps;
  private readonly denialDeps: DenialDeps;
  private readonly relayBridge: RelayBridge;
  private readonly defaultScanRoot: string;
  private readonly logger: import('@dorkos/shared/logger').Logger;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onUnregisterCallbacks: Array<(agentId: string) => void> = [];

  /**
   * Create the Mesh coordination core.
   *
   * @param options - Configuration options
   */
  constructor(options: MeshOptions) {
    const registry = new AgentRegistry(options.db);
    const denialList = new DenialList(options.db);
    const relayBridge = new RelayBridge(options.relayCore, options.signalEmitter);
    const topology = new TopologyManager(registry, relayBridge, options.relayCore);
    const defaultScanRoot = options.defaultScanRoot ?? os.homedir();
    const logger = options.logger ?? console;
    const strategies = options.strategies ?? [
      new ClaudeCodeStrategy(),
      new CursorStrategy(),
      new CodexStrategy(),
      new WindsurfStrategy(),
      new GeminiStrategy(),
      new ClineStrategy(),
      new RooCodeStrategy(),
      new CopilotStrategy(),
      new AmazonQStrategy(),
      new ContinueStrategy(),
    ];

    this.relayBridge = relayBridge;
    this.defaultScanRoot = defaultScanRoot;
    this.logger = logger;
    this.discoveryDeps = {
      registry,
      denialList,
      relayBridge,
      strategies,
      defaultScanRoot,
      logger,
      generateUlid: monotonicFactory(),
    };
    this.agentDeps = {
      registry,
      relayBridge,
      topology,
      signalEmitter: options.signalEmitter,
      logger,
      onUnregisterCallbacks: this.onUnregisterCallbacks,
    };
    this.denialDeps = { denialList };
  }

  // --- Discovery & Registration ---

  /** Scan root directories for agent candidates. */
  async *discover(
    roots: string[],
    options?: Omit<UnifiedScanOptions, 'root'>
  ): AsyncGenerator<ScanEvent> {
    yield* discovery.discover(roots, this.discoveryDeps, options);
  }

  /** Register a discovered candidate as a full agent. */
  async register(
    candidate: DiscoveryCandidate,
    overrides?: Partial<AgentManifest>,
    approver?: string,
    scanRoot?: string
  ): Promise<AgentManifest> {
    return discovery.register(candidate, this.discoveryDeps, overrides, approver, scanRoot);
  }

  /** Register an agent directly by project path without prior discovery. */
  async registerByPath(
    projectPath: string,
    partial: Partial<AgentManifest> & { name: string; runtime: AgentRuntime },
    approver?: string,
    scanRoot?: string
  ): Promise<AgentManifest> {
    return discovery.registerByPath(projectPath, partial, this.discoveryDeps, approver, scanRoot);
  }

  // --- Denial ---

  /** Add a project path to the denial list. */
  async deny(filePath: string, reason?: string, denier?: string): Promise<void> {
    return denial.deny(this.denialDeps, filePath, reason, denier);
  }

  /** Remove a project path from the denial list. */
  async undeny(filePath: string): Promise<void> {
    return denial.undeny(this.denialDeps, filePath);
  }

  /** List all denial records. */
  listDenied(): DenialRecord[] {
    return denial.listDenied(this.denialDeps);
  }

  // --- Agent Management ---

  /** Update mutable fields of a registered agent (ADR-0043 write-through). */
  async update(
    agentId: string,
    partial: Partial<AgentManifest>
  ): Promise<AgentManifest | undefined> {
    return agentMgmt.update(this.agentDeps, agentId, partial);
  }

  /** Sync a single agent from its `.dork/agent.json` file into the DB. */
  async syncFromDisk(projectPath: string): Promise<boolean> {
    return agentMgmt.syncFromDisk(projectPath, this.discoveryDeps);
  }

  /** Unregister an agent by ID (ADR-0043: deletes manifest, DB entry, Relay endpoint). */
  async unregister(agentId: string): Promise<void> {
    return agentMgmt.unregister(this.agentDeps, agentId);
  }

  /** Register a callback to be invoked when an agent is unregistered. */
  onUnregister(callback: (agentId: string) => void): void {
    this.onUnregisterCallbacks.push(callback);
  }

  // --- Query ---

  /** List all registered agents, optionally filtered by runtime, capability, or namespace. */
  list(filters?: {
    runtime?: AgentRuntime;
    capability?: string;
    callerNamespace?: string;
  }): AgentManifest[] {
    return agentMgmt.list(this.agentDeps, filters);
  }

  /** List agents with computed health status included. */
  listWithHealth(filters?: { runtime?: AgentRuntime; capability?: string }): (AgentManifest & {
    healthStatus: AgentHealthStatus;
    lastSeenAt: string | null;
    lastSeenEvent: string | null;
  })[] {
    return agentMgmt.listWithHealth(this.agentDeps, filters);
  }

  /** List registered agents with their project paths (lightweight view). */
  listWithPaths(): Array<{
    id: string;
    name: string;
    displayName?: string;
    projectPath: string;
    icon?: string;
    color?: string;
  }> {
    return agentMgmt.listWithPaths(this.agentDeps);
  }

  /** Get an agent manifest by ULID. */
  get(agentId: string): AgentManifest | undefined {
    return agentMgmt.get(this.agentDeps, agentId);
  }

  /** Get an agent manifest by project path. */
  getByPath(projectPath: string): AgentManifest | undefined {
    return agentMgmt.getByPath(this.agentDeps, projectPath);
  }

  /** Get the project path for a registered agent. */
  getProjectPath(agentId: string): string | undefined {
    return agentMgmt.getProjectPath(this.agentDeps, agentId);
  }

  // --- Topology ---

  /** Get the topology view filtered by caller's namespace access. */
  getTopology(callerNamespace: string): TopologyView {
    return agentMgmt.getTopology(this.agentDeps, callerNamespace);
  }

  /** Get which agents a specific agent can reach. */
  getAgentAccess(agentId: string): AgentManifest[] | undefined {
    return agentMgmt.getAgentAccess(this.agentDeps, agentId);
  }

  /** Add a cross-namespace allow rule via Relay access control. */
  allowCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    agentMgmt.allowCrossNamespace(this.agentDeps, sourceNamespace, targetNamespace);
  }

  /** Remove a cross-namespace allow rule (reverts to default-deny). */
  denyCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    agentMgmt.denyCrossNamespace(this.agentDeps, sourceNamespace, targetNamespace);
  }

  /** List all cross-namespace access rules. */
  listCrossNamespaceRules(): CrossNamespaceRule[] {
    return agentMgmt.listCrossNamespaceRules(this.agentDeps);
  }

  // --- Health & Observability ---

  /** Update the last-seen timestamp and event for an agent. */
  updateLastSeen(agentId: string, event: string): void {
    agentMgmt.updateLastSeen(this.agentDeps, agentId, event);
  }

  /** Get the health status for a single agent. */
  getAgentHealth(agentId: string): AgentHealth | undefined {
    return agentMgmt.getAgentHealth(this.agentDeps, agentId);
  }

  /** Get aggregate mesh status -- counts by health status plus runtime and project groupings. */
  getStatus(): MeshStatus {
    return agentMgmt.getStatus(this.agentDeps);
  }

  /** Get a detailed inspection of a single agent combining manifest, health, and relay info. */
  inspect(agentId: string): MeshInspect | undefined {
    return agentMgmt.inspect(this.agentDeps, agentId);
  }

  // --- Reconciliation ---

  /** Run a one-shot anti-entropy reconciliation between filesystem and DB. */
  async reconcileOnStartup(): Promise<ReconcileResult> {
    return reconcile(this.discoveryDeps.registry, this.relayBridge, this.defaultScanRoot);
  }

  /**
   * Start periodic background reconciliation at the given interval.
   * No-ops if already running. The timer is unref'd so it does not prevent process exit.
   *
   * @param intervalMs - Reconciliation interval in milliseconds (default: 5 minutes)
   */
  startPeriodicReconciliation(intervalMs = 300_000): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(async () => {
      try {
        await reconcile(this.discoveryDeps.registry, this.relayBridge, this.defaultScanRoot);
      } catch (err) {
        this.logger.error('[Mesh] Periodic reconciliation failed:', err);
      }
    }, intervalMs);
    this.reconcileTimer.unref();
  }

  /** Stop periodic background reconciliation. */
  stopPeriodicReconciliation(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** Retained for backward compatibility. Stops periodic reconciliation. */
  close(): void {
    this.stopPeriodicReconciliation();
  }
}
