/**
 * Anti-entropy reconciler between filesystem and DB.
 *
 * Checks each DB entry's path on disk, syncs updated manifests,
 * marks missing paths as unreachable, and resurrects agents whose
 * paths come back (e.g. a remounted volume). Unreachable orphans
 * are auto-removed past a 24-hour grace period, with a final
 * accessibility re-check before removal.
 *
 * @module mesh/reconciler
 */
import { access } from 'node:fs/promises';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import { readManifest } from './manifest.js';
import { resolveNamespace } from './namespace-resolver.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** 24-hour grace period before auto-removing unreachable agents. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Summary of reconciliation actions taken. */
export interface ReconcileResult {
  /** DB entries updated from file. */
  synced: number;
  /** Newly marked unreachable. */
  unreachable: number;
  /** Auto-removed after grace period. */
  removed: number;
  /** Previously unreachable agents whose paths came back. */
  resurrected: number;
  /** New agents found on disk (reserved for future use). */
  discovered: number;
}

/** Dependencies required by {@link reconcile}. */
export interface ReconcilerDeps {
  /** The agent registry to reconcile. */
  registry: AgentRegistry;
  /** Default scan root for namespace resolution. */
  defaultScanRoot: string;
  /**
   * Remove an agent through the full unregister cascade (Relay endpoint,
   * registry row, onUnregister callbacks). Sweep-removed agents have
   * inaccessible paths, so the cascade must never require the manifest file
   * to exist — callbacks receive the entry's recorded projectPath instead.
   */
  removeAgent: (entry: AgentRegistryEntry) => Promise<void>;
  /** Logger for structured output. */
  logger: import('@dorkos/shared/logger').Logger;
}

/**
 * Full anti-entropy reconciliation between filesystem and DB.
 *
 * 1. Check each DB entry's path exists on disk
 * 2. For existing paths, clear any unreachable status and sync file -> DB if data differs
 * 3. Mark missing paths as unreachable
 * 4. Auto-remove unreachable entries past grace period, re-verifying path
 *    accessibility first — a path that came back (e.g. a remounted volume)
 *    resurrects the agent instead of removing it. Removal routes through
 *    `deps.removeAgent` so the same cleanup cascade fires as for a manual
 *    unregister (Relay endpoint, registry row, onUnregister callbacks).
 *
 * @param deps - Reconciler dependencies
 * @returns Summary of reconciliation actions taken
 */
export async function reconcile(deps: ReconcilerDeps): Promise<ReconcileResult> {
  const { registry, defaultScanRoot } = deps;
  const result: ReconcileResult = {
    synced: 0,
    unreachable: 0,
    removed: 0,
    resurrected: 0,
    discovered: 0,
  };

  // Build set of already-unreachable IDs to avoid re-marking (which resets grace timer)
  const unreachableIds = new Set(registry.listUnreachable().map((e) => e.id));

  const entries = registry.list();

  for (const entry of entries) {
    const pathExists = await pathAccessible(entry.projectPath);

    if (!pathExists) {
      if (!unreachableIds.has(entry.id)) {
        registry.markUnreachable(entry.id);
        result.unreachable++;
      }
      continue;
    }

    // Path exists — clear unreachable status if previously marked, so the
    // agent stops counting toward the grace-period removal sweep. Only count
    // when the update lands (the agent may have been concurrently removed).
    if (unreachableIds.has(entry.id) && registry.markReachable(entry.id)) {
      result.resurrected++;
    }

    // Sync file -> DB
    const manifest = await readManifest(entry.projectPath);
    if (!manifest) continue;

    if (manifestDiffersFromEntry(manifest, entry)) {
      const namespace = resolveNamespace(
        entry.projectPath,
        entry.scanRoot || defaultScanRoot,
        manifest.namespace
      );
      registry.update(entry.id, {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        runtime: manifest.runtime,
        capabilities: manifest.capabilities,
        behavior: manifest.behavior,
        budget: manifest.budget,
        namespace,
        persona: manifest.persona,
        personaEnabled: manifest.personaEnabled,
        color: manifest.color,
        icon: manifest.icon,
      });
      result.synced++;
    }
  }

  // Auto-remove orphans past grace period
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
  const expired = registry.listUnreachableBefore(cutoff);
  for (const entry of expired) {
    // Re-verify before permanent removal: a path that is accessible again
    // (e.g. an external volume remounted after a weekend) means the agent
    // is back — resurrect it instead of deleting it from DB and Relay.
    if (await pathAccessible(entry.projectPath)) {
      if (registry.markReachable(entry.id)) {
        result.resurrected++;
      }
      continue;
    }
    // Route through the shared unregister cascade so consumers (task
    // schedules, file watchers) clean up exactly as for a manual unregister.
    // Isolate per-agent failures — one bad agent must not abort the sweep.
    try {
      await deps.removeAgent(entry);
      result.removed++;
    } catch (err) {
      deps.logger.warn('[Mesh] Failed to remove expired unreachable agent', {
        agentId: entry.id,
        err,
      });
    }
  }

  return result;
}

/** Check if a filesystem path is accessible. */
async function pathAccessible(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Compare manifest fields against registry entry. */
function manifestDiffersFromEntry(manifest: AgentManifest, entry: AgentRegistryEntry): boolean {
  // ADR-0043: sync direction is file → DB; all mutable fields must be compared
  return (
    manifest.name !== entry.name ||
    (manifest.displayName ?? undefined) !== (entry.displayName ?? undefined) ||
    manifest.description !== entry.description ||
    manifest.runtime !== entry.runtime ||
    JSON.stringify(manifest.capabilities) !== JSON.stringify(entry.capabilities) ||
    JSON.stringify(manifest.behavior) !== JSON.stringify(entry.behavior) ||
    JSON.stringify(manifest.budget) !== JSON.stringify(entry.budget) ||
    (manifest.persona ?? undefined) !== (entry.persona ?? undefined) ||
    (manifest.personaEnabled ?? true) !== (entry.personaEnabled ?? true) ||
    (manifest.color ?? undefined) !== (entry.color ?? undefined) ||
    (manifest.icon ?? undefined) !== (entry.icon ?? undefined)
  );
}
