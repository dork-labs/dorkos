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
import type { RelayBridge } from './relay-bridge.js';
import { resolveNamespace, normalizeNamespace } from './namespace-resolver.js';
import { unifiedScan } from './discovery/unified-scanner.js';
import type { ScanEvent, UnifiedScanOptions } from './discovery/types.js';
import { writeManifest, removeManifest } from './manifest.js';

/** Default registrar identifier when none is provided. */
export const DEFAULT_REGISTRAR = 'mesh';

/** Dependencies required by discovery and registration functions. */
export interface DiscoveryDeps {
  registry: AgentRegistry;
  denialList: DenialList;
  relayBridge: RelayBridge;
  strategies: DiscoveryStrategy[];
  defaultScanRoot: string;
  logger: import('@dorkos/shared/logger').Logger;
  generateUlid: ReturnType<typeof monotonicFactory>;
}

/**
 * Scan root directories for agent candidates.
 *
 * Yields all `ScanEvent` types: `candidate`, `auto-import`, `progress`, and `complete`.
 * Auto-import events are upserted into the registry automatically before being yielded.
 * Already-registered and denied paths are skipped automatically.
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
  for (const root of roots) {
    for await (const event of unifiedScan(
      { ...options, root, logger: options?.logger ?? deps.logger },
      deps.strategies,
      deps.registry,
      deps.denialList
    )) {
      if (event.type === 'auto-import') {
        // Auto-import: upsert into registry before yielding, recording the
        // actual root this manifest was found under — not defaultScanRoot,
        // which in production falls back to the homedir and would poison
        // later reconciler walks with a whole-home root.
        await upsertAutoImported(event.data.manifest, event.data.path, deps, root);
      }
      yield event;
    }
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
 * @param scanRoot - Root directory for namespace derivation (default: deps.defaultScanRoot)
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
  const effectiveScanRoot = scanRoot ?? deps.defaultScanRoot;
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
    enabledToolGroups: overrides?.enabledToolGroups ?? {},
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
 * @param scanRoot - Root directory for namespace derivation (default: deps.defaultScanRoot)
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
  const effectiveScanRoot = scanRoot ?? deps.defaultScanRoot;
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
    enabledToolGroups: partial.enabledToolGroups ?? {},
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
 * Upsert an auto-imported agent manifest into the registry.
 *
 * Always syncs manifest data to the DB via idempotent upsert,
 * handling both new and previously-registered agents.
 *
 * The recorded scan root is, in order of preference: the root the manifest was
 * actually found under (`scanRoot`, passed by `discover()`), the scan root
 * already recorded on an existing registry entry (preserved by `syncFromDisk`,
 * which has no scan context), then `deps.defaultScanRoot` as a last resort.
 * Recording the real root matters: `defaultScanRoot` falls back to the homedir
 * in production, and a persisted `$HOME` scan root would make the reconciler's
 * rebuild-from-files walk the user's entire home directory every pass.
 *
 * @param manifest - The auto-imported agent manifest
 * @param projectPath - Absolute path to the agent's project directory
 * @param deps - Discovery dependencies
 * @param scanRoot - The root directory the manifest was discovered under
 */
export async function upsertAutoImported(
  manifest: AgentManifest,
  projectPath: string,
  deps: DiscoveryDeps,
  scanRoot?: string
): Promise<void> {
  // Registry rows persist scanRoot as '' when unknown — treat that as absent.
  const existingScanRoot = deps.registry.getByPath(projectPath)?.scanRoot || undefined;
  const effectiveScanRoot = scanRoot ?? existingScanRoot ?? deps.defaultScanRoot;
  const namespace = resolveAutoImportNamespace(manifest, projectPath, effectiveScanRoot, deps);
  const entry: AgentRegistryEntry = {
    ...manifest,
    projectPath,
    namespace,
    scanRoot: effectiveScanRoot,
  };

  // Upsert handles both new and existing agents
  deps.registry.upsert(entry);

  // Ensure Relay endpoint exists
  await deps.relayBridge.registerAgent(manifest, projectPath, namespace, effectiveScanRoot);
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
