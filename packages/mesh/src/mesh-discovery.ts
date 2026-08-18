/**
 * Discovery and registration logic extracted from MeshCore.
 *
 * Contains the `discover()` async generator, `register()`, `registerByPath()`,
 * and the internal `registerInternal()` / `upsertAutoImported()` pipelines.
 *
 * @module mesh/mesh-discovery
 */
import path from 'path';
import { monotonicFactory } from 'ulidx';
import type { AgentManifest, AgentRuntime, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from './types.js';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { DenialList } from './denial-list.js';
import { subjectForAgent, type RelayBridge } from './relay-bridge.js';
import { resolveNamespace, normalizeNamespace } from './namespace-resolver.js';
import { unifiedScan } from './discovery/unified-scanner.js';
import type { ScanEvent, UnifiedScanOptions } from './discovery/types.js';
import { writeManifest, removeManifest, probeManifest } from './manifest.js';

/** Default registrar identifier when none is provided. */
export const DEFAULT_REGISTRAR = 'mesh';

/**
 * What an auto-import did with one manifest.
 *
 * - `registered` — the row was written where the manifest was found.
 * - `relocated` — the agent's directory genuinely changed, and the row followed.
 * - `duplicate-id` — another directory still holds this manifest (or its state
 *   could not be read), so nothing was written anywhere.
 */
export type AutoImportResult = 'registered' | 'relocated' | 'duplicate-id';

/**
 * Every duplicate manifest one scan refused, so the scan says it once.
 *
 * **Per scan run, not per `(id, path)` and not per process.** A per-pair damp
 * would still print nine lines on the first scan of a repo with nine linked
 * worktrees; a per-process damp would never speak again once the situation
 * changed. Aggregating for the length of one traversal is what the damping is
 * actually for: one line per stolen identity, naming every copy that tried.
 */
export class DuplicateManifestReport {
  private readonly refused = new Map<string, { registeredPath: string; rejectedPaths: string[] }>();

  /**
   * Note that a directory tried to register an id another directory holds.
   *
   * @param agentId - The contested manifest ULID.
   * @param registeredPath - Where the agent is actually registered.
   * @param rejectedPath - The copy that was refused.
   */
  record(agentId: string, registeredPath: string, rejectedPath: string): void {
    const seen = this.refused.get(agentId);
    if (seen) {
      if (!seen.rejectedPaths.includes(rejectedPath)) seen.rejectedPaths.push(rejectedPath);
      return;
    }
    this.refused.set(agentId, { registeredPath, rejectedPaths: [rejectedPath] });
  }

  /**
   * Write one warning per contested id, then forget them.
   *
   * `warn` rather than `info` because nobody is told any other way: a refused
   * duplicate simply does not appear, and this line is the only record that a
   * checkout on this machine is carrying somebody else's identity.
   *
   * @param logger - Where the warnings go.
   */
  flush(logger: import('@dorkos/shared/logger').Logger): void {
    for (const [agentId, { registeredPath, rejectedPaths }] of this.refused) {
      logger.warn('[mesh] a duplicate agent manifest was refused registration', {
        event: 'mesh.identity.duplicate_manifest',
        agentId,
        registeredPath,
        rejectedPaths,
      });
    }
    this.refused.clear();
  }
}

/**
 * An agent a scan adopted for the first time — the identity a reaction needs to
 * seat it. Mirrors what the DorkOS server's agent-created seam expects.
 */
export interface AdoptedAgent {
  /** The agent's id (manifest `id`). */
  id: string;
  /** The agent's slug (manifest `name`). */
  name: string;
  /** The agent's display name, when set. */
  displayName?: string;
  /** The directory the manifest was found in — the rooms domain keys on it. */
  path: string;
}

/** Dependencies required by discovery and registration functions. */
export interface DiscoveryDeps {
  registry: AgentRegistry;
  denialList: DenialList;
  relayBridge: RelayBridge;
  strategies: DiscoveryStrategy[];
  defaultScanRoot: string;
  /**
   * The managed agents home directory (`{dorkHome}/agents`), when the host has
   * one. Every agent under it derives its namespace from it, whatever root a
   * particular scan came in on — see {@link managedScanRoot}.
   */
  agentsHomeDir?: string;
  logger: import('@dorkos/shared/logger').Logger;
  generateUlid: ReturnType<typeof monotonicFactory>;
  /**
   * Called once for each agent a scan adopts that this machine had never
   * registered before. Optional — absent outside a wired-up {@link MeshCore}.
   */
  onAgentAdopted?: (agent: AdoptedAgent) => void;
}

/**
 * The scan root a managed agent's namespace must be derived from, when the
 * agent is one — otherwise `undefined`.
 *
 * Agents DorkOS creates for you (and DorkBot) live under
 * `{dorkHome}/agents/<slug>`, and the reconciler walks that directory every
 * five minutes. Deriving their namespace from anything else means two answers
 * for one agent: creation used to fall back to the home directory and produce
 * `dork` (the first segment of `.dork/agents/<slug>`), the reconciler produced
 * `<slug>`, and the agent's Relay identity moved out from under it minutes
 * after it was made (DOR-1342).
 *
 * So the agents home dir wins over every other candidate — the root a scan
 * came in on included. A scan rooted at the home directory walking past
 * `~/.dork/agents` is the same agent seen from further away, not a different
 * agent, and it must not be re-namespaced.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param deps - Discovery dependencies (for the configured agents home dir)
 * @returns The agents home dir when `projectPath` sits inside it, else undefined
 */
function managedScanRoot(projectPath: string, deps: DiscoveryDeps): string | undefined {
  const home = deps.agentsHomeDir;
  if (!home) return undefined;
  const relative = path.relative(home, projectPath);
  const inside = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  return inside ? home : undefined;
}

/**
 * Scan root directories for agent candidates.
 *
 * Yields all `ScanEvent` types: `candidate`, `auto-import`, `progress`, and `complete`.
 * Auto-import events are upserted into the registry automatically before being yielded.
 * Already-registered and denied paths are skipped automatically.
 *
 * Adoption — an agent this machine had never registered before — also fires
 * `deps.onAgentAdopted`, which is how a scanned-in agent takes its #team seat
 * without waiting for the next boot (DOR-1042). It fires HERE and not inside
 * {@link upsertAutoImported}, because `syncFromDisk` shares that pipeline and
 * its callers (the agent-creator, `POST /api/agents`) already announce the
 * agent themselves — firing in both places would seat every created agent twice.
 *
 * @param roots - Root directories to scan
 * @param deps - Discovery dependencies (registry, denialList, strategies, etc.)
 * @param options - Scan configuration (maxDepth, timeout, followSymlinks, extraExcludes)
 * @returns Async generator of ScanEvent objects
 */
export async function* discover(
  roots: string[],
  deps: DiscoveryDeps,
  options?: Omit<UnifiedScanOptions, 'root'>
): AsyncGenerator<ScanEvent> {
  const logger = options?.logger ?? deps.logger;
  // One report for the whole run, across every root: a scan of two roots that
  // both contain the same stolen manifest is still one theft to report.
  const duplicates = new DuplicateManifestReport();
  try {
    for (const root of roots) {
      for await (const event of unifiedScan(
        { ...options, root, logger },
        deps.strategies,
        deps.registry,
        deps.denialList
      )) {
        if (event.type === 'auto-import') {
          // Auto-import: upsert into registry before yielding, recording the
          // actual root this manifest was found under — not defaultScanRoot,
          // which in production falls back to the homedir and would poison
          // later reconciler walks with a whole-home root.
          //
          // Read "did we already know this id?" BEFORE the upsert. The scanner
          // re-yields every manifest-bearing directory it walks past, whether
          // registered or not, and the reconciler runs a scan every five
          // minutes — so the outcome alone cannot tell an adoption from a
          // re-observation, and only this read can.
          const { manifest, path: agentPath } = event.data;
          const alreadyKnown = deps.registry.get(manifest.id) !== undefined;
          const outcome = await upsertAutoImported(manifest, agentPath, deps, root, duplicates);
          if (!alreadyKnown && outcome === 'registered') {
            announceAdoption(manifest, agentPath, deps);
          }
        }
        yield event;
      }
    }
  } finally {
    // In `finally` because a scan is routinely abandoned mid-stream — an SSE
    // client disconnecting calls the generator's `return()` — and the refusals
    // it already collected are exactly as real as a completed scan's.
    duplicates.flush(logger);
  }
}

/**
 * Tell the host that a scan adopted an agent it had never registered before.
 *
 * Failures are swallowed: a reaction that throws must never abort the scan it
 * rode in on, and the agents around it are already registered by the time it
 * runs.
 *
 * @param manifest - The adopted agent's manifest.
 * @param projectPath - The directory the manifest was found in.
 * @param deps - Discovery dependencies (the callback and the logger).
 */
function announceAdoption(manifest: AgentManifest, projectPath: string, deps: DiscoveryDeps): void {
  if (!deps.onAgentAdopted) return;
  try {
    deps.onAgentAdopted({
      id: manifest.id,
      name: manifest.name,
      displayName: manifest.displayName,
      path: projectPath,
    });
  } catch (err) {
    deps.logger.warn('[mesh] an agent-adopted callback threw', {
      event: 'mesh.identity.adoption_callback_failed',
      agentId: manifest.id,
      projectPath,
      err,
    });
  }
}

/**
 * Register a discovered candidate as a full agent.
 *
 * Generates a ULID, merges candidate hints with optional overrides,
 * writes `.dork/agent.json`, inserts into the registry, and registers
 * a Relay endpoint if RelayCore is available.
 *
 * @param candidate - A DiscoveryCandidate yielded from discover()
 * @param deps - Discovery dependencies
 * @param overrides - Optional manifest field overrides
 * @param approver - Identifier of the entity approving registration (default: "mesh")
 * @param scanRoot - Root directory for namespace derivation. Ignored for an agent
 *   under the managed agents home dir, whose namespace always derives from that
 *   directory (see {@link managedScanRoot}); otherwise defaults to
 *   `deps.defaultScanRoot`.
 * @returns The created AgentManifest
 */
export async function register(
  candidate: DiscoveryCandidate,
  deps: DiscoveryDeps,
  overrides?: Partial<AgentManifest>,
  approver = DEFAULT_REGISTRAR,
  scanRoot?: string
): Promise<AgentManifest> {
  const id = deps.generateUlid();
  const now = new Date().toISOString();
  const effectiveScanRoot =
    managedScanRoot(candidate.path, deps) ?? scanRoot ?? deps.defaultScanRoot;
  const namespace = resolveNamespace(candidate.path, effectiveScanRoot, overrides?.namespace);

  const manifest: AgentManifest = {
    id,
    name: overrides?.name ?? candidate.hints.suggestedName,
    description: overrides?.description ?? candidate.hints.description ?? '',
    runtime: overrides?.runtime ?? candidate.hints.detectedRuntime,
    capabilities: overrides?.capabilities ?? candidate.hints.inferredCapabilities ?? [],
    behavior: overrides?.behavior ?? { responseMode: 'always' },
    namespace,
    registeredAt: overrides?.registeredAt ?? now,
    registeredBy: overrides?.registeredBy ?? approver,
    persona: overrides?.persona,
    personaEnabled: overrides?.personaEnabled ?? true,
    isSystem: overrides?.isSystem ?? false,
    color: overrides?.color,
    icon: overrides?.icon,
    model: overrides?.model,
    effort: overrides?.effort,
    enabledToolGroups: overrides?.enabledToolGroups ?? {},
    mcpServers: [],
  };

  return registerInternal(candidate.path, manifest, namespace, effectiveScanRoot, deps);
}

/**
 * Register an agent directly by project path without prior discovery.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param partial - Manifest fields to set (name, runtime are required)
 * @param deps - Discovery dependencies
 * @param approver - Identifier of the entity approving registration (default: "mesh")
 * @param scanRoot - Root directory for namespace derivation. Ignored for an agent
 *   under the managed agents home dir, whose namespace always derives from that
 *   directory (see {@link managedScanRoot}); otherwise defaults to
 *   `deps.defaultScanRoot`.
 * @returns The created AgentManifest
 */
export async function registerByPath(
  projectPath: string,
  partial: Partial<AgentManifest> & { name: string; runtime: AgentRuntime },
  deps: DiscoveryDeps,
  approver = DEFAULT_REGISTRAR,
  scanRoot?: string
): Promise<AgentManifest> {
  const id = deps.generateUlid();
  const now = new Date().toISOString();
  const effectiveScanRoot = managedScanRoot(projectPath, deps) ?? scanRoot ?? deps.defaultScanRoot;
  const namespace = resolveNamespace(projectPath, effectiveScanRoot, partial.namespace);

  const manifest: AgentManifest = {
    id,
    name: partial.name,
    description: partial.description ?? '',
    runtime: partial.runtime,
    capabilities: partial.capabilities ?? [],
    behavior: partial.behavior ?? { responseMode: 'always' },
    namespace,
    registeredAt: partial.registeredAt ?? now,
    registeredBy: partial.registeredBy ?? approver,
    persona: partial.persona,
    personaEnabled: partial.personaEnabled ?? true,
    isSystem: partial.isSystem ?? false,
    color: partial.color,
    icon: partial.icon,
    model: partial.model,
    effort: partial.effort,
    enabledToolGroups: partial.enabledToolGroups ?? {},
    mcpServers: [],
  };

  return registerInternal(projectPath, manifest, namespace, effectiveScanRoot, deps);
}

/**
 * Shared registration pipeline: write manifest, upsert DB, register Relay.
 *
 * Steps are ordered for safe rollback: if DB upsert fails the manifest file
 * is removed; if Relay registration fails both the DB entry and manifest are
 * removed (compensation pattern).
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param manifest - The agent manifest to persist
 * @param namespace - Resolved namespace string
 * @param scanRoot - Root directory used for namespace derivation
 * @param deps - Discovery dependencies
 * @returns The manifest (unchanged, for caller convenience)
 */
async function registerInternal(
  projectPath: string,
  manifest: AgentManifest,
  namespace: string,
  scanRoot: string,
  deps: DiscoveryDeps
): Promise<AgentManifest> {
  // Step 1: Write manifest to disk (atomic tmp+rename)
  await writeManifest(projectPath, manifest);

  // Step 2: Upsert into DB (idempotent)
  const entry: AgentRegistryEntry = {
    ...manifest,
    projectPath,
    namespace,
    scanRoot,
  };
  try {
    // The id was minted a few lines up by `register`/`registerByPath`, so the
    // `'duplicate-id'` branch is unreachable from here and there is nothing to
    // handle: an id nothing has ever seen cannot already live somewhere else.
    deps.registry.upsert(entry);
  } catch (err) {
    // Compensate: remove manifest file
    await removeManifest(projectPath);
    throw err;
  }

  // Step 3: Register with Relay
  try {
    await deps.relayBridge.registerAgent(manifest, projectPath, namespace, scanRoot);
  } catch (err) {
    // Compensate: remove DB entry and manifest file
    deps.registry.remove(manifest.id);
    await removeManifest(projectPath);
    throw err;
  }

  return manifest;
}

/**
 * Upsert an auto-imported agent manifest into the registry — or refuse it,
 * when another directory still holds the same manifest.
 *
 * Syncs manifest data to the DB via idempotent upsert, handling both new and
 * previously-registered agents.
 *
 * **The relocation guard lives here**, because this is the layer that may do
 * I/O (ADR 260801-003050). `AgentRegistry.upsert` refuses an id that has moved;
 * this decides what that refusal means by reading the incumbent directory's
 * manifest under strict errno discipline ({@link probeManifest}):
 *
 * - **absent** (`ENOENT`/`ENOTDIR`) — the incumbent released the manifest, so
 *   this is a genuine move. {@link AgentRegistry.relocate}, one `info`.
 * - **a different id** — the incumbent gave this id up. Same: a genuine move.
 * - **the same id** — two directories carry one manifest. Refuse; write nothing.
 * - **unreadable** (`EACCES`, `EIO`, a parse failure, a schema failure) —
 *   refuse. Reading "could not tell" as "gone" would hand the identity to a
 *   duplicate irreversibly, and the guard would then refuse the true owner's
 *   return.
 *
 * The recorded scan root is, in order of preference: the managed agents home
 * dir when the agent lives under it ({@link managedScanRoot} — the one root
 * that must win, so a managed agent's namespace is the same at creation as it
 * is after the next reconcile), the root the manifest was actually found under
 * (`scanRoot`, passed by `discover()`), the scan root already recorded on an
 * existing registry entry (preserved by `syncFromDisk`, which has no scan
 * context), then `deps.defaultScanRoot` as a last resort. Recording the real
 * root matters: `defaultScanRoot` falls back to the homedir in production, and
 * a persisted `$HOME` scan root would make the reconciler's rebuild-from-files
 * walk the user's entire home directory every pass.
 *
 * When the resolved namespace differs from the one the registry already held
 * for this directory, the agent's previous Relay identity is retired — see
 * {@link retirePreviousNamespace}.
 *
 * @param manifest - The auto-imported agent manifest
 * @param projectPath - Absolute path to the agent's project directory
 * @param deps - Discovery dependencies
 * @param scanRoot - The root directory the manifest was discovered under
 * @param duplicates - The running scan's refusal report. Omitted outside a scan
 *   (`syncFromDisk`), in which case a refusal is reported on the spot.
 * @returns What happened to this manifest.
 */
export async function upsertAutoImported(
  manifest: AgentManifest,
  projectPath: string,
  deps: DiscoveryDeps,
  scanRoot?: string,
  duplicates?: DuplicateManifestReport
): Promise<AutoImportResult> {
  const existing = deps.registry.getByPath(projectPath);
  // Registry rows persist scanRoot as '' when unknown — treat that as absent.
  const existingScanRoot = existing?.scanRoot || undefined;
  const effectiveScanRoot =
    managedScanRoot(projectPath, deps) ?? scanRoot ?? existingScanRoot ?? deps.defaultScanRoot;
  const namespace = resolveAutoImportNamespace(manifest, projectPath, effectiveScanRoot, deps);
  const entry: AgentRegistryEntry = {
    ...manifest,
    projectPath,
    namespace,
    scanRoot: effectiveScanRoot,
  };

  // The identity this agent had before this write, so a namespace change can
  // take its old Relay identity down with it. For a relocation the previous
  // identity lives on the incumbent row, not on this path — set below.
  let previous: { namespace: string; projectPath: string } | undefined = existing
    ? { namespace: existing.namespace, projectPath: existing.projectPath }
    : undefined;

  // Upsert handles both new and existing agents — and refuses, writing nothing,
  // when this id already belongs to another directory.
  let outcome: AutoImportResult = 'registered';
  if (deps.registry.upsert(entry) === 'duplicate-id') {
    const incumbent = deps.registry.get(manifest.id);
    // The row is what made `upsert` refuse, so it is there. Belt-and-braces
    // against a concurrent unregister between the two reads: with no incumbent
    // there is no conflict left, so let the registration through.
    if (incumbent === undefined) {
      // Whatever the retry says is the answer — reporting `registered` for a
      // second refusal would put the lie back one layer down.
      if (deps.registry.upsert(entry) === 'duplicate-id') return 'duplicate-id';
    } else if (await incumbentReleasedManifest(incumbent.projectPath, manifest.id, deps)) {
      previous = { namespace: incumbent.namespace, projectPath: incumbent.projectPath };
      deps.registry.relocate(manifest.id, projectPath);
      // Re-run so the move carries the manifest's current fields too: `relocate`
      // moves the row, `upsert` syncs it, and the two together are what a
      // genuine move means.
      deps.registry.upsert(entry);
      deps.logger.info('[mesh] an agent moved to a new directory', {
        event: 'mesh.identity.relocated',
        agentId: manifest.id,
        from: incumbent.projectPath,
        to: projectPath,
      });
      outcome = 'relocated';
    } else {
      const report = duplicates ?? new DuplicateManifestReport();
      report.record(manifest.id, incumbent.projectPath, projectPath);
      // Outside a scan there is nothing to aggregate against, so say it now.
      if (!duplicates) report.flush(deps.logger);
      return 'duplicate-id';
    }
  }

  // Ensure Relay endpoint exists
  await deps.relayBridge.registerAgent(manifest, projectPath, namespace, effectiveScanRoot);

  // The new identity is live before the old one is taken down, so the agent is
  // never momentarily unaddressable.
  if (previous && previous.namespace && previous.namespace !== namespace) {
    await retirePreviousNamespace(manifest.id, previous, namespace, deps);
  }
  return outcome;
}

/**
 * Take down the Relay identity an agent had before its namespace changed.
 *
 * A managed agent's namespace no longer moves under it (see
 * {@link managedScanRoot}), so a change here is either a one-time correction on
 * an install that predates that fix, an agent that genuinely moved directories,
 * or a manifest whose `namespace` a person edited. All three leave the same
 * debris behind if nothing cleans up: an endpoint on a subject nobody reads,
 * and — once the last agent leaves a namespace — that namespace's default
 * access rules allowing and denying traffic for nobody.
 *
 * Warned, not logged quietly: for a managed agent this should now never
 * happen, so a line here is a signal worth looking at.
 *
 * Every step is best-effort. A failure to tidy up the identity an agent used to
 * have must never fail the write that gave it a working one.
 *
 * @param agentId - The agent whose namespace changed
 * @param previous - The namespace and directory it had before
 * @param namespace - The namespace it has now
 * @param deps - Discovery dependencies (registry, relay bridge, logger)
 */
async function retirePreviousNamespace(
  agentId: string,
  previous: { namespace: string; projectPath: string },
  namespace: string,
  deps: DiscoveryDeps
): Promise<void> {
  deps.logger.warn('[mesh] an agent changed namespace', {
    event: 'mesh.identity.namespace_changed',
    agentId,
    from: previous.namespace,
    to: namespace,
  });
  try {
    await deps.relayBridge.retireSubject(
      subjectForAgent({
        id: agentId,
        namespace: previous.namespace,
        projectPath: previous.projectPath,
      })
    );
    if (deps.registry.listByNamespace(previous.namespace).length === 0) {
      deps.relayBridge.cleanupNamespaceRules(previous.namespace);
    }
  } catch (err) {
    deps.logger.warn('[mesh] could not retire the identity an agent used to have', {
      event: 'mesh.identity.retire_failed',
      agentId,
      previousNamespace: previous.namespace,
      err,
    });
  }
}

/**
 * Whether the directory that currently holds `agentId` has genuinely given it
 * up — the one question that turns a refused registration into a relocation.
 *
 * Only two states say yes, and everything else says no. See
 * {@link upsertAutoImported} for why "could not read it" must be a no.
 *
 * @param incumbentPath - Where the agent is registered today.
 * @param agentId - The contested manifest ULID.
 * @param deps - Discovery dependencies (for the logger).
 */
async function incumbentReleasedManifest(
  incumbentPath: string,
  agentId: string,
  deps: DiscoveryDeps
): Promise<boolean> {
  const probe = await probeManifest(incumbentPath);
  if (probe.state === 'absent') return true;
  if (probe.state === 'present') return probe.id !== agentId;
  deps.logger.warn('[mesh] could not read an agent manifest, so its identity was not moved', {
    event: 'mesh.identity.incumbent_unreadable',
    agentId,
    incumbentPath,
    detail: probe.detail,
  });
  return false;
}

/**
 * Resolve a namespace for an auto-imported manifest without ever throwing.
 *
 * Auto-import runs inside the `discover()` generator, so a thrown error
 * propagates out and aborts the entire scan (killing an SSE discovery stream
 * with an opaque error). Manifests created outside the scan root — e.g. by the
 * agents route or agent-creator, which omit `namespace` — make the strict
 * {@link resolveNamespace} throw. Here we fall back to the project directory's
 * basename (normalized) so one out-of-boundary manifest never nukes the scan.
 *
 * @param manifest - The auto-imported manifest (may carry a namespace override)
 * @param projectPath - Absolute path to the agent's project directory
 * @param scanRoot - The effective scan root to derive the namespace from
 * @param deps - Discovery dependencies (for the logger)
 * @returns A valid, normalized namespace string
 */
function resolveAutoImportNamespace(
  manifest: AgentManifest,
  projectPath: string,
  scanRoot: string,
  deps: DiscoveryDeps
): string {
  try {
    return resolveNamespace(projectPath, scanRoot, manifest.namespace);
  } catch (err) {
    const fallback = normalizeNamespace(path.basename(projectPath)) || 'default';
    deps.logger.warn('[Mesh] Auto-import namespace derivation failed; falling back to basename', {
      projectPath,
      fallback,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
