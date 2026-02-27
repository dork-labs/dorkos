/**
 * Anti-entropy reconciler between filesystem and DB.
 *
 * Checks each DB entry's path on disk, syncs updated manifests,
 * marks missing paths as unreachable, and auto-removes orphans
 * past a 24-hour grace period.
 *
 * @module mesh/reconciler
 */
import { access } from 'node:fs/promises';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { RelayBridge } from './relay-bridge.js';
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
  /** New agents found on disk (reserved for future use). */
  discovered: number;
}

/**
 * Full anti-entropy reconciliation between filesystem and DB.
 *
 * 1. Check each DB entry's path exists on disk
 * 2. For existing paths, sync file -> DB if data differs
 * 3. Mark missing paths as unreachable
 * 4. Auto-remove unreachable entries past grace period
 *
 * @param registry - The agent registry to reconcile
 * @param relayBridge - Relay bridge for unregistering orphaned agents
 * @param defaultScanRoot - Default scan root for namespace resolution
 * @returns Summary of reconciliation actions taken
 */
export async function reconcile(
  registry: AgentRegistry,
  relayBridge: RelayBridge,
  defaultScanRoot: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    synced: 0,
    unreachable: 0,
    removed: 0,
    discovered: 0,
  };

  // Build set of already-unreachable IDs to avoid re-marking (which resets grace timer)
  const unreachableIds = new Set(
    registry.listUnreachable().map((e) => e.id),
  );

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

    // Path exists — sync file -> DB
    const manifest = await readManifest(entry.projectPath);
    if (!manifest) continue;

    if (manifestDiffersFromEntry(manifest, entry)) {
      const namespace = resolveNamespace(
        entry.projectPath,
        entry.scanRoot || defaultScanRoot,
        manifest.namespace,
      );
      registry.update(entry.id, {
        name: manifest.name,
        description: manifest.description,
        runtime: manifest.runtime,
        capabilities: manifest.capabilities,
        behavior: manifest.behavior,
        budget: manifest.budget,
        namespace,
      });
      result.synced++;
    }
  }

  // Auto-remove orphans past grace period
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
  const expired = registry.listUnreachableBefore(cutoff);
  for (const entry of expired) {
    const subject = `relay.agent.${entry.namespace}.${entry.id}`;
    await relayBridge.unregisterAgent(subject, entry.id, entry.name);
    registry.remove(entry.id);
    result.removed++;
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
function manifestDiffersFromEntry(
  manifest: AgentManifest,
  entry: AgentRegistryEntry,
): boolean {
  return (
    manifest.name !== entry.name ||
    manifest.description !== entry.description ||
    manifest.runtime !== entry.runtime ||
    JSON.stringify(manifest.capabilities) !== JSON.stringify(entry.capabilities) ||
    JSON.stringify(manifest.behavior) !== JSON.stringify(entry.behavior) ||
    JSON.stringify(manifest.budget) !== JSON.stringify(entry.budget)
  );
}
