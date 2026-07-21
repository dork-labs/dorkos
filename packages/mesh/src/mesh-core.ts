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
import type { DiscoveryStrategy } from './types.js';
import { AgentRegistry } from './agent-registry.js';
import { DenialList } from './denial-list.js';
import { RelayBridge } from './relay-bridge.js';
import { NamespaceRuleStore } from './namespace-rule-store.js';
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
import type { ReconcileResult, ReconcilerDeps } from './reconciler.js';
import * as discovery from './mesh-discovery.js';
import type { DiscoveryDeps } from './mesh-discovery.js';
import * as agentMgmt from './mesh-agent-management.js';
import type { AgentManagementDeps } from './mesh-agent-management.js';
import * as denial from './mesh-denial.js';
import type { DenialDeps } from './mesh-denial.js';

/**
 * BFS depth for the reconciler's periodic rebuild-from-files discovery.
 * Deliberately shallow: the managed agents home dir nests agents one level
 * deep (`agents/<name>`) and scan-root layouts one to two levels
 * (`<root>/<namespace>/<project>`). A shallow walk keeps the every-5-minute
 * cadence cheap; deeper trees remain recoverable via an explicit discovery scan.
 */
const RECONCILE_DISCOVERY_MAX_DEPTH = 2;

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
  /**
   * The managed agents home directory (`${dorkHome}/agents`). The reconciler
   * walks it on every pass to rebuild the DB from files (ADR-0043) — it holds
   * the system agent (DorkBot) and marketplace-installed agents. Optional:
   * when absent, reconciler disk discovery still runs over recorded scan roots
   * but skips the agents home dir.
   */
  agentsHomeDir?: string;
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
  private readonly defaultScanRoot: string;
  /**
   * Set when `defaultScanRoot` came from the homedir safety-net fallback (no
   * explicit option). Recorded scan roots equal to this value are excluded
   * from the reconciler's disk-discovery walk — walking the user's entire
   * home directory every 5 minutes is never acceptable.
   */
  private readonly homedirFallbackRoot: string | null;
  private readonly agentsHomeDir?: string;
  private readonly logger: import('@dorkos/shared/logger').Logger;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onUnregisterCallbacks: Array<(agentId: string, projectPath: string) => void> =
    [];
  private readonly onLivenessChangeCallbacks: Array<(result: ReconcileResult) => void> = [];

  /**
   * Create the Mesh coordination core.
   *
   * @param options - Configuration options
   */
  constructor(options: MeshOptions) {
    const registry = new AgentRegistry(options.db);
    const denialList = new DenialList(options.db);
    const relayBridge = new RelayBridge(options.relayCore, options.signalEmitter);
    const namespaceRuleStore = new NamespaceRuleStore(options.db);
    const topology = new TopologyManager(
      registry,
      relayBridge,
      namespaceRuleStore,
      options.relayCore
    );
    // Adopt any cross-namespace allow rules already living in Relay (one-time
    // migration) and project the store's rules back into Relay so the enforcer
    // matches the Mesh-owned source of truth (mesh #16).
    topology.syncNamespaceRulesFromRelay();
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

    this.defaultScanRoot = defaultScanRoot;
    this.homedirFallbackRoot = options.defaultScanRoot === undefined ? defaultScanRoot : null;
    this.agentsHomeDir = options.agentsHomeDir;
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

  /**
   * Register a callback to be invoked when an agent is unregistered.
   *
   * The callback receives the agent's project path captured before registry
   * removal — the registry entry is already gone when callbacks fire, so
   * `getProjectPath(agentId)` would return undefined.
   */
  onUnregister(callback: (agentId: string, projectPath: string) => void): void {
    this.onUnregisterCallbacks.push(callback);
  }

  /**
   * Register a callback fired after a periodic reconciliation pass that flipped
   * at least one agent's liveness — newly marked unreachable (went offline) or
   * resurrected (came back online). The DorkOS server wires this to the
   * `/api/events` SSE fan-out so the Pulse attention badge ticks on the real
   * transition edge instead of waiting for the next 30s mesh-status poll
   * (DOR-403). Callbacks fire ONLY when `unreachable > 0 || resurrected > 0`, so
   * a steady-state pass with no change broadcasts nothing.
   *
   * @param callback - Invoked with the reconcile result on a liveness transition.
   */
  onLivenessChange(callback: (result: ReconcileResult) => void): void {
    this.onLivenessChangeCallbacks.push(callback);
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

  /**
   * List agents with computed health status included. When `callerNamespace`
   * is provided, results are scoped to reachable namespaces (pass `'*'` for the
   * admin view) while keeping the health-enriched, projectPath-stripped shape.
   */
  listWithHealth(filters?: {
    runtime?: AgentRuntime;
    capability?: string;
    callerNamespace?: string;
  }): (AgentManifest & {
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

  /**
   * Resolve an agent's canonical Relay identity (subject + id) by project path.
   *
   * Built from the un-stripped registry entry so the subject carries the same
   * resolved namespace the Relay endpoint and access rules were registered
   * with — identical to the `relaySubject` that `inspect()` reports. Use this
   * (never `getByPath()`, whose manifest has `namespace` stripped) when the
   * subject participates in access control.
   */
  getSubjectByPath(projectPath: string): { subject: string; agentId: string } | undefined {
    return agentMgmt.getSubjectByPath(this.agentDeps, projectPath);
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
    return reconcile(this.reconcilerDeps());
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
        const result = await reconcile(this.reconcilerDeps());
        // Fire liveness observers ONLY on a real transition edge — an agent went
        // offline (newly unreachable) or came back online (resurrected). A
        // no-change pass broadcasts nothing (DOR-403).
        if (result.unreachable > 0 || result.resurrected > 0) {
          this.notifyLivenessChange(result);
        }
      } catch (err) {
        this.logger.error('[Mesh] Periodic reconciliation failed:', err);
      }
    }, intervalMs);
    this.reconcileTimer.unref();
  }

  /**
   * Invoke every registered liveness-change observer, isolating failures so one
   * bad listener cannot break the reconcile loop or the others.
   *
   * @param result - The reconcile result carrying the transition counts.
   */
  private notifyLivenessChange(result: ReconcileResult): void {
    for (const callback of this.onLivenessChangeCallbacks) {
      try {
        callback(result);
      } catch (err) {
        this.logger.warn('[Mesh] onLivenessChange callback threw', { err });
      }
    }
  }

  /**
   * Build reconciler dependencies. Sweep removals route through the shared
   * `removeAgent` cascade so onUnregister callbacks fire exactly as for a
   * manual unregister — manifest deletion is skipped because sweep-removed
   * agents have inaccessible paths.
   */
  private reconcilerDeps(): ReconcilerDeps {
    return {
      registry: this.discoveryDeps.registry,
      defaultScanRoot: this.defaultScanRoot,
      logger: this.logger,
      removeAgent: (entry) => agentMgmt.removeAgent(this.agentDeps, entry),
      discoverOnDisk: (recordedScanRoots) => this.discoverAgentsFromDisk(recordedScanRoots),
    };
  }

  /**
   * Discover agents on disk that are missing from the DB and register them.
   *
   * Implements the ADR-0043 "delete the DB and let reconciliation rebuild it
   * from files" contract. Scans a **bounded** set of roots — the managed agents
   * home dir (`${dorkHome}/agents`, holding DorkBot + installed agents) plus the
   * scan roots recorded on surviving DB entries — never a full home-directory
   * walk. Reuses the `discover()` pipeline, which auto-imports every
   * `.dork/agent.json` it finds (respecting the denial list) and skips already
   * registered paths. Walks only {@link RECONCILE_DISCOVERY_MAX_DEPTH} levels so
   * the every-5-minute cadence stays cheap; deeper trees are recoverable via an
   * explicit discovery scan.
   *
   * Recorded roots equal to the homedir safety-net fallback are skipped:
   * entries persisted before scan-root plumbing landed (or auto-imported when
   * `defaultScanRoot` was unset) carry `$HOME` as their scan root, and walking
   * the user's whole home directory — the developer's REAL home in dev, where
   * dorkHome points at `.temp/` — every 5 minutes is never acceptable. Those
   * agents remain synced via the entry loop; only orphan discovery under such
   * roots requires an explicit scan.
   *
   * @param recordedScanRoots - Distinct scan roots from current DB entries
   * @returns Count of agents newly registered by this pass
   */
  private async discoverAgentsFromDisk(recordedScanRoots: string[]): Promise<number> {
    const safeRecordedRoots = recordedScanRoots.filter((r) => {
      if (this.homedirFallbackRoot !== null && r === this.homedirFallbackRoot) {
        this.logger.warn(
          '[Mesh] Skipping homedir-fallback scan root in reconciler disk discovery',
          { root: r }
        );
        return false;
      }
      return true;
    });
    const roots = Array.from(
      new Set([...(this.agentsHomeDir ? [this.agentsHomeDir] : []), ...safeRecordedRoots])
    ).filter((r) => r.length > 0);
    if (roots.length === 0) return 0;

    // Snapshot registered paths before the walk so we can count only agents
    // that were genuinely absent — discover() upserts auto-imports in place.
    const knownPaths = new Set(this.discoveryDeps.registry.list().map((e) => e.projectPath));

    let discovered = 0;
    for await (const event of this.discover(roots, { maxDepth: RECONCILE_DISCOVERY_MAX_DEPTH })) {
      if (event.type === 'auto-import' && !knownPaths.has(event.data.path)) {
        discovered++;
      }
    }
    if (discovered > 0) {
      this.logger.info('[Mesh] Reconciler rebuilt agents from disk', { discovered });
    }
    return discovered;
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
