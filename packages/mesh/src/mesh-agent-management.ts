/**
 * Agent management operations extracted from MeshCore.
 *
 * Contains list/get/update/unregister operations, health & observability
 * methods, status snapshots, and agent inspection.
 *
 * @module mesh/mesh-agent-management
 */
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
import type { DenialList } from './denial-list.js';
import { isManifestGitTracked } from './git-tracked.js';
import type { RelayBridge } from './relay-bridge.js';
import { subjectForAgent } from './relay-bridge.js';
import type { TopologyManager, TopologyView, CrossNamespaceRule } from './topology.js';
import { readManifest, probeManifest, writeManifest, removeManifest } from './manifest.js';
import type { DiscoveryDeps } from './mesh-discovery.js';
import { upsertAutoImported } from './mesh-discovery.js';

/**
 * What {@link syncFromDisk} did with a directory.
 *
 * - `synced` — the manifest was read and its row written (a genuine relocation
 *   counts, because the agent really did move).
 * - `no-manifest` — there is no readable `.dork/agent.json` there.
 * - `duplicate-id` — the manifest names an id another directory still holds, so
 *   nothing was written.
 */
export type SyncFromDiskResult = 'synced' | 'no-manifest' | 'duplicate-id';

/** Dependencies required by agent management functions. */
export interface AgentManagementDeps {
  registry: AgentRegistry;
  /**
   * The denial list, so an unregister that has to LEAVE a manifest on disk can
   * stop the next scan adopting it straight back (see {@link unregister}).
   */
  denialList: DenialList;
  relayBridge: RelayBridge;
  topology: TopologyManager;
  signalEmitter: SignalEmitter | undefined;
  logger: import('@dorkos/shared/logger').Logger;
  /**
   * Callbacks fired after an agent is unregistered. They receive the agent's
   * project path captured before registry removal — by the time they run, the
   * registry entry is gone, so lookups by id would return nothing.
   */
  onUnregisterCallbacks: Array<(agentId: string, projectPath: string) => void>;
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
 * The single response shape for `GET /api/mesh/agents`: every entry carries
 * `healthStatus`, `lastSeenAt`, and `lastSeenEvent`, and `projectPath` is
 * stripped per the manifest contract. When `callerNamespace` is provided,
 * results are narrowed to the namespaces that caller can reach (invisible
 * boundary enforcement via TopologyManager; pass `'*'` for the admin view) —
 * unlike a raw topology query, this keeps the health fields and hides the
 * project path.
 *
 * @param deps - Agent management dependencies
 * @param filters - Optional runtime, capability, and/or callerNamespace filters
 * @returns Array of agent manifests with health fields (projectPath stripped)
 */
export function listWithHealth(
  deps: AgentManagementDeps,
  filters?: { runtime?: AgentRuntime; capability?: string; callerNamespace?: string }
): (AgentManifest & {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
})[] {
  const entries = deps.registry.listWithHealth({
    runtime: filters?.runtime,
    capability: filters?.capability,
  });

  if (!filters?.callerNamespace) {
    return entries.map((entry) => toManifest(entry));
  }

  // Namespace-scoped visibility: keep only agents the caller can see, using the
  // same topology boundary as list(), but preserve the health-enriched shape.
  const view = deps.topology.getTopology(filters.callerNamespace);
  const visibleIds = new Set(view.namespaces.flatMap((ns) => ns.agents.map((a) => a.id)));
  return entries.filter((entry) => visibleIds.has(entry.id)).map((entry) => toManifest(entry));
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
export function listWithPaths(deps: AgentManagementDeps): Array<{
  id: string;
  name: string;
  displayName?: string;
  projectPath: string;
  icon?: string;
  color?: string;
}> {
  return deps.registry.list().map((e) => ({
    id: e.id,
    name: e.name,
    displayName: e.displayName,
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
 * Resolve an agent's canonical Relay identity from its project path.
 *
 * Uses the UN-stripped registry entry, so the subject is built from the same
 * resolved namespace that registration keyed the endpoint and access rules on
 * (`toManifest` strips `namespace`, which is why `getByPath()` cannot be used
 * for identity — its `namespace` is always undefined and `subjectForAgent`
 * would silently fall back to `basename(projectPath)`, matching no rule for
 * nested or explicit-namespace agents).
 *
 * @param deps - Agent management dependencies
 * @param projectPath - Absolute path to the agent's project directory
 * @returns The agent's relay subject and id, or undefined if not registered
 */
export function getSubjectByPath(
  deps: AgentManagementDeps,
  projectPath: string
): { subject: string; agentId: string } | undefined {
  const entry = deps.registry.getByPath(projectPath);
  if (!entry) return undefined;
  return { subject: subjectForAgent(entry), agentId: entry.id };
}

/**
 * Resolve an agent's canonical Relay subject from its id.
 *
 * The by-id twin of {@link getSubjectByPath}, and built the same way: from the
 * UN-stripped registry entry, so the result is byte-identical to the
 * `relaySubject` {@link inspect} reports and to the subject RelayBridge
 * registered the endpoint and access rules with. `get()` cannot stand in for it
 * — its public manifest has `namespace` stripped, so a subject rebuilt from one
 * silently degrades to `basename(projectPath)` and matches no rule.
 *
 * Exists because two callers need the subject without the health snapshot
 * `inspect()` also computes: `mesh_list`, which decorates every listed agent
 * with the address the caller must send to, and the send tools' subject
 * canonicalizer, which asks "is this bare id a registered agent, and what is
 * its real address?" once per call.
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @returns The agent's canonical relay subject, or undefined if not registered
 */
export function getSubject(deps: AgentManagementDeps, agentId: string): string | undefined {
  const entry = deps.registry.get(agentId);
  if (!entry) return undefined;
  return subjectForAgent(entry);
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
 * The one refusal {@link update} raises on its own: the manifest is THERE and
 * cannot be read, so writing would destroy what only that file holds.
 *
 * A class rather than a bare `Error` because the route above it has to answer
 * this differently from everything else that can throw on the same line —
 * `writeManifest` rejects a schema-invalid merge, and an I/O failure can surface
 * from either call. Catching all of them as one turned a validation bug into a
 * `409 MANIFEST_UNREADABLE` carrying raw internals, which is both a wrong status
 * and a wrong story (DOR-486 re-review). Callers must narrow on
 * `instanceof`, never on the message.
 */
export class ManifestUnreadableError extends Error {
  /**
   * Build the refusal, wording it for the person who has to fix the file.
   *
   * @param projectPath - The agent directory whose manifest could not be read.
   * @param detail - The errno, parse error, or schema issues behind it.
   */
  constructor(
    public readonly projectPath: string,
    public readonly detail: string
  ) {
    super(
      `Refusing to update ${projectPath}: its .dork/agent.json is present but could not be ` +
        `read (${detail}). Writing over it would erase the settings only that file holds. ` +
        `Fix or remove the file, then try again.`
    );
    this.name = 'ManifestUnreadableError';
  }
}

/**
 * Update mutable fields of a registered agent.
 *
 * ADR-0043: writes to `.dork/agent.json` first (canonical), then updates DB (cache).
 * If the manifest file is ABSENT, reconstructs from the DB entry before writing.
 *
 * **An UNREADABLE manifest is refused rather than reconstructed** (DOR-486
 * review). The DB row is a LOSSY cache — it has no column for
 * `enabledToolGroups`, `mcpServers`, `workspace` or `tierCeiling` — so
 * reconstructing from it turns any PATCH into a silent erase of every one of
 * those, and for `tierCeiling` that erase WIDENS a security control: an agent
 * capped at `observe` would come back uncapped because somebody renamed a
 * display name while its manifest happened to be malformed. `probeManifest`
 * separates "demonstrably gone" (reconstructing is the recovery path, and there
 * is nothing to lose) from "here and unreadable" (reconstructing destroys), which
 * `readManifest`'s single `null` cannot.
 *
 * **The read, the merge and the write are NOT atomic, and nothing locks
 * `.dork/agent.json`.** `writeManifest` is atomic per write (temp file +
 * rename), so no reader ever sees a half-file — but two updates that overlap
 * both read the same base and the later `rename` wins whole, so the earlier
 * one's fields are lost. That is a property of this seam for every field, and it
 * predates tier ceilings; it is called out here because a ceiling is the field
 * where losing an update is a SECURITY outcome rather than a cosmetic one (an
 * operator's lowering dropped by a concurrent display-name write leaves the agent
 * wider than the person believes). What the window cannot do is invent a value
 * nobody sent — every ceiling that reaches the file passed
 * `agent-updater.ts`'s direction guard, or came from the operator's own route.
 * Closing it properly means locking the manifest for read-modify-write, which is
 * a change to this function for all its callers rather than to one field
 * (DOR-486 review).
 *
 * @param deps - Agent management dependencies
 * @param agentId - The agent's ULID
 * @param partial - Fields to update (name, description, capabilities, etc.)
 * @returns The updated agent manifest, or undefined if not found
 * @throws {ManifestUnreadableError} When the manifest is present but cannot be read.
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
  if (!diskManifest) {
    const probe = await probeManifest(entry.projectPath);
    if (probe.state === 'unreadable') {
      throw new ManifestUnreadableError(entry.projectPath, probe.detail);
    }
  }
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
 * What an unregister did on disk, for a caller that has to say so.
 *
 * `manifestKept` is the durable second effect a person has to be told about:
 * their file is still there AND the folder is now denied, which is a state they
 * will meet again the next time they look at that directory (DOR-1019).
 */
export interface UnregisterResult {
  /** Whether the manifest was left on disk (git tracks it) and the path denied. */
  manifestKept: boolean;
}

/**
 * Unregister an agent by ID.
 *
 * ADR-0043: releases `.dork/agent.json` on disk, then runs the shared
 * removal cascade (Relay endpoint, registry row, unregister callbacks).
 *
 * @param deps - Agent management dependencies
 * @param agentId - The ULID of the agent to unregister
 * @returns What happened to the manifest on disk.
 */
export async function unregister(
  deps: AgentManagementDeps,
  agentId: string
): Promise<UnregisterResult> {
  const agent = deps.registry.get(agentId);
  if (!agent) return { manifestKept: false };

  // ADR-0043: settle the manifest file first, so nothing can re-discover the
  // agent between here and the cascade below.
  const manifestKept = await releaseManifest(deps, agent.projectPath);

  await removeAgent(deps, agent);
  return { manifestKept };
}

/**
 * Give up the manifest of an agent being unregistered — by deleting it, or,
 * when git is tracking it, by leaving it alone and denying the directory.
 *
 * Deleting is the default and the reason is ADR-0043: the file is what makes an
 * agent real, so an unregistered agent whose manifest survives is adopted again
 * by the next scan, and the reconciler runs one every five minutes.
 *
 * **A manifest git tracks is not ours to delete** (DOR-1019). It was committed
 * on purpose, teammates get it on clone, and unregistering an agent is a
 * statement about this machine's roster — never a licence to change somebody's
 * source tree. It cost this repo its own `.dork/agent.json` once already; only
 * a person reading `git status` got it back.
 *
 * Denying the directory is what keeps both halves true at once: the file stays,
 * and the agent still does not come back. The denial is visible in the denied
 * list with its reason, and registering the directory again clears it
 * (`mesh-discovery.clearDenial`).
 *
 * @param deps - Agent management dependencies (denial list and logger).
 * @param projectPath - The unregistering agent's project directory.
 * @returns `true` when the file was kept and the directory denied instead.
 */
async function releaseManifest(deps: AgentManagementDeps, projectPath: string): Promise<boolean> {
  if (!(await isManifestGitTracked(projectPath, deps.logger))) {
    await removeManifest(projectPath);
    return false;
  }

  deps.denialList.deny(
    projectPath,
    'Removed from your agents. Its .dork/agent.json is tracked by git, so the file was left alone.',
    'mesh'
  );
  deps.logger.info('[mesh] left a git-tracked agent manifest in place on unregister', {
    event: 'mesh.manifest.tracked_kept',
    projectPath,
  });
  return true;
}

/**
 * Remove an agent from Relay, the registry, and fire unregister callbacks.
 *
 * Shared removal cascade used by manual {@link unregister} and the
 * reconciler's grace-period sweep. Manifest deletion is deliberately NOT
 * part of this routine: manual unregister deletes the file first (ADR-0043),
 * while sweep-removed agents have inaccessible paths where no file
 * operation can succeed.
 *
 * @param deps - Agent management dependencies
 * @param agent - The registry entry to remove (captured before removal so
 *   callbacks still receive the recorded project path)
 */
export async function removeAgent(
  deps: AgentManagementDeps,
  agent: AgentRegistryEntry
): Promise<void> {
  await deps.relayBridge.unregisterAgent(subjectForAgent(agent), agent.id, agent.name);

  deps.registry.remove(agent.id);

  // Fire unregister callbacks (e.g., cascade-disable Tasks schedules) with the
  // project path captured before removal — the registry entry no longer exists.
  for (const cb of deps.onUnregisterCallbacks) {
    try {
      cb(agent.id, agent.projectPath);
    } catch (err) {
      deps.logger.warn('[Mesh] Unregister callback failed', { agentId: agent.id, err });
    }
  }

  // Clean up namespace rules if this was the last agent in the namespace
  if (agent.namespace) {
    const remaining = deps.registry.listByNamespace(agent.namespace);
    if (remaining.length === 0) {
      deps.relayBridge.cleanupNamespaceRules(agent.namespace);
    }
  }
}

/**
 * Sync a single agent from its `.dork/agent.json` file into the DB.
 *
 * ADR-0043: enables immediate file-to-DB sync without waiting for the
 * 5-minute periodic reconciler. Reuses the auto-import upsert pipeline.
 *
 * **Three outcomes, not two, and the third is why this stopped returning a
 * boolean.** A manifest can now be found, read, and still refused — because
 * another directory holds the same id (ADR 260801-003050). Reporting that as
 * `false` would collapse it into "there is no manifest here", which is the exact
 * collapse the relocation guard exists to reject one layer down.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param discoveryDeps - Discovery dependencies (needed for upsertAutoImported)
 * @returns `'synced'` when the manifest reached the DB (a genuine relocation
 *   included), `'no-manifest'` when the directory holds none, `'duplicate-id'`
 *   when another directory still holds this identity and nothing was written.
 */
export async function syncFromDisk(
  projectPath: string,
  discoveryDeps: DiscoveryDeps
): Promise<SyncFromDiskResult> {
  const manifest = await readManifest(projectPath, discoveryDeps.logger);
  if (!manifest) return 'no-manifest';
  const result = await upsertAutoImported(manifest, projectPath, discoveryDeps);
  return result === 'duplicate-id' ? 'duplicate-id' : 'synced';
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

  // Derive relay subject using the same grammar as registration
  const relaySubject = subjectForAgent(entry);

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
