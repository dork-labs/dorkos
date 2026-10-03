import path from 'path';

import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';

import { configManager } from '../../core/config-manager.js';

import {
  isApprovedByDigest,
  isApprovedByOrigin,
  isApprovedByPath,
  isFromTrustedSource,
  mayRunExtensionCode,
} from '../extension-load-policy.js';
import { logger } from '../../../lib/logger.js';
import { collectSnapshots, ensureSnapshot } from '../extension-snapshots.js';
import { installRootOf } from '../extension-trusted-origin.js';
import type { ManagerState } from './state.js';
const PROJECT_RESCAN_DEBOUNCE_MS = 2_000;
function isSameCwd(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return path.resolve(a) === path.resolve(b);
}
import { applyCompileResult } from './commands.js';
/** Discover configured extension copies and initialize their owned watchers. */
export async function initialize(state: ManagerState, cwd: string | null): Promise<void> {
  state.currentCwd = cwd;
  await state.compiler.cleanStaleCache();
  // Nothing runs yet, so there is nothing to switch: scan, then start below.
  await state.operations.enqueue(() => rescan(state));

  for (const record of state.extensions.values()) {
    if (needsServer(state, record)) {
      try {
        const result = await state.serverLifecycle.initialize(record.id, record);
        if (!result.ok) {
          logger.warn(`[Extensions] Server init skipped for ${record.id}: ${result.error}`);
        }
      } catch (err) {
        logger.error(
          `[Extensions] Server init threw an unexpected error for ${record.id} — skipping it and continuing with the rest`,
          err
        );
      }
    }
  }
  await collectUnusedSnapshots(state);
}

/** Serialize a full discovery refresh before returning its public snapshot. */
export async function reload(state: ManagerState): Promise<ExtensionRecordPublic[]> {
  await state.operations.enqueue(() => switchCopies(state));
  return state.operations.readPublic();
}

/** Coalesce filesystem notifications into the existing serialized queue. */
export function requestRefresh(state: ManagerState): void {
  void state.operations
    .enqueue(() => switchCopies(state))
    .catch((err) => {
      logger.warn('[Extensions] A background re-scan failed', err);
    });
}

/** Discover the current copies and update the manager-owned records. */
export async function rescan(state: ManagerState): Promise<void> {
  const config = configManager.get('extensions');
  const projects = await readProjectRoots(state);
  const discovered = await state.discovery.discover(
    state.currentCwd,
    config,
    state.coreExtensions,
    projects
  );
  const records = discovered.filter((rec) => !rec.shadowedBy);
  state.shadowed = discovered.filter((rec) => !!rec.shadowedBy);

  state.extensions.clear();
  for (const rec of records) {
    state.extensions.set(rec.id, rec);
  }
  state.operations.bindUnsourcedApprovals(records);
  await placeSnapshots(state, records);

  await compileEnabled(state);
  state.operations.emitChanged();
}

/** Materialize immutable copy snapshots before compiling their code. */
export async function placeSnapshots(
  state: ManagerState,
  records: readonly ExtensionRecord[]
): Promise<void> {
  const approvals = configManager.get('extensions');
  for (const record of records) {
    if (record.scope !== 'local' || !record.sourcePlugin || !record.pinnedDigest) continue;
    // A yes pinned to these exact files runs them from the snapshot too.
    const pinned = isApprovedByDigest(record, approvals);
    const byOrigin =
      !!record.trustedOrigin &&
      !isApprovedByPath(record, approvals) &&
      (isApprovedByOrigin(record, approvals) || isFromTrustedSource(record, approvals));
    if (!pinned && !byOrigin) continue;
    const installRoot = installRootOf(record.path);
    const root = await ensureSnapshot(state.dorkHome, installRoot, record.pinnedDigest);
    if (root) {
      record.runPath = path.join(root, path.relative(installRoot, record.path));
    } else {
      // Its files changed since the scan: nothing here may run, by origin or
      // by a yes pinned to the files it had.
      record.trustedOrigin = undefined;
      record.pinnedDigest = undefined;
      record.currentDigest = undefined;
      record.originProblem = 'changed';
    }
  }
}

/** Remove snapshots no longer referenced by any current copy. */
export async function collectUnusedSnapshots(state: ManagerState): Promise<void> {
  const inUse = new Set<string>();
  for (const record of state.extensions.values()) {
    if (record.runPath) inUse.add(path.resolve(installRootOf(record.runPath)));
  }
  try {
    await collectSnapshots(state.dorkHome, inUse);
  } catch (err) {
    logger.warn('[Extensions] Could not clear unused extension snapshots', err);
  }
}

/** Watch the project list with the same serialized refresh owner. */
export function followProjects(
  state: ManagerState,
  source: {
    roots: (cwd: string | null) => Promise<readonly string[]>;
    onChange: (listener: () => void) => () => void;
  },
  options: { debounceMs?: number; announce?: (ids: string[]) => void } = {}
): () => void {
  state.projectRoots = source.roots;
  if (options.announce) state.announceReloaded = options.announce;
  const debounceMs = options.debounceMs ?? PROJECT_RESCAN_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = source.onChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      requestRefresh(state);
    }, debounceMs);
    timer.unref?.();
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Read the configured project roots without changing the current selection. */
export async function readProjectRoots(state: ManagerState): Promise<readonly string[]> {
  if (!state.projectRoots) return [];
  try {
    return await state.projectRoots(state.currentCwd);
  } catch (err) {
    logger.warn('[Extensions] Could not read the known projects; scanning only this folder', err);
    return [];
  }
}

/** Select current extension copies for the active working directory. */
export async function switchCopies(state: ManagerState): Promise<string[]> {
  const before = new Map(
    [...state.extensions.values()].map((rec) => [
      rec.id,
      {
        path: path.resolve(rec.path),
        runPath: rec.runPath ?? null,
        runs: mayRunExtensionCode(rec, configManager.get('extensions')),
      },
    ])
  );
  await rescan(state);
  const approvals = configManager.get('extensions');
  const changed: string[] = [];
  for (const rec of state.extensions.values()) {
    const prior = before.get(rec.id);
    const runs = mayRunExtensionCode(rec, approvals);
    const switched =
      !prior ||
      prior.path !== path.resolve(rec.path) ||
      prior.runPath !== (rec.runPath ?? null) ||
      prior.runs !== runs;
    if (!switched) continue;
    changed.push(rec.id);
    if (prior) await state.serverLifecycle.shutdown(rec.id);
    if (runs && needsServer(state, rec)) {
      const result = await state.serverLifecycle.initialize(rec.id, rec);
      if (!result.ok) {
        logger.warn(
          `[Extensions] Server init on the new copy of ${rec.id} failed: ${result.error}`
        );
      }
    }
  }
  for (const id of before.keys()) {
    if (!state.extensions.has(id)) {
      changed.push(id);
      await state.serverLifecycle.shutdown(id);
    }
  }
  // Only now, with every server half on its current copy, can a snapshot the
  // old copies ran from go.
  await collectUnusedSnapshots(state);
  if (changed.length > 0) state.announceReloaded?.(changed);
  return changed;
}

/** Serialize a working-directory switch and publish its completed state. */
export async function updateCwd(
  state: ManagerState,
  newCwd: string | null
): Promise<{ added: string[]; removed: string[] }> {
  if (isSameCwd(newCwd, state.currentCwd)) {
    return { added: [], removed: [] };
  }

  const oldIds = new Set(state.extensions.keys());
  state.currentCwd = newCwd;
  await reload(state);
  const newIds = new Set(state.extensions.keys());

  return {
    added: [...newIds].filter((id) => !oldIds.has(id)),
    removed: [...oldIds].filter((id) => !newIds.has(id)),
  };
}

/** Determine whether the current copy declares server-side capabilities. */
export function needsServer(state: ManagerState, record: ExtensionRecord): boolean {
  return (
    (record.hasServerEntry || record.hasDataProxy) && ['compiled', 'active'].includes(record.status)
  );
}

/** Compile the current enabled and approved extension copies. */
export async function compileEnabled(state: ManagerState): Promise<void> {
  const enabled = Array.from(state.extensions.values()).filter((r) => r.status === 'enabled');
  for (const record of enabled) {
    try {
      const result = await state.compiler.compile(record);
      applyCompileResult(record, result);
    } catch (err) {
      logger.error(
        `[Extensions] Compile threw an unexpected error for ${record.id} — skipping it and continuing with the rest`,
        err
      );
      record.status = 'compile_error';
      record.error = {
        code: 'compilation_failed',
        message: err instanceof Error ? err.message : String(err),
      };
      record.bundleReady = false;
    }
  }
}
