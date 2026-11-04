/** Remove only crash leftovers captured by DorkOS, while no Codex can use them. */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import type { CodexAppServerPool } from '../app-server/process-pool.js';
import { assertNoLiveCodex, withCodexRegistryLock } from './mount-target-guard.js';
import {
  readMountTargets,
  removableMountTarget,
  writeMountTargets,
} from './mount-target-ledger.js';

/** Only test seams replace the lock/OS guard; production always uses both. */
export interface MountReconcileGuard {
  lock<T>(action: (registry: string) => T): Promise<T>;
  assertGone(registry: string): void;
}
const nativeGuard: MountReconcileGuard = {
  lock: withCodexRegistryLock,
  assertGone: assertNoLiveCodex,
};

/**
 * Run before process acquisition and at startup. Busy or unverifiable cleanup
 * skips removal; no incomplete pool or OS snapshot can authorize an unlink.
 */
export async function reconcileMountTargets(
  data: string,
  pool: Pick<CodexAppServerPool, 'list' | 'closeIdleForReconcile'>,
  guard: MountReconcileGuard = nativeGuard
): Promise<string[]> {
  if (process.platform !== 'linux' && guard === nativeGuard) return [];
  try {
    const recorded = readMountTargets(data);
    if (recorded.length === 0) return [];
    const remaining = recorded.filter((file) => {
      try {
        fs.lstatSync(file);
        return true;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return false;
        throw error;
      }
    });
    if (!remaining.some((file) => removableMountTarget(file))) return [];
    // Keep absent records until guarded cleanup: an in-flight helper could
    // still create that target after this snapshot.
    await pool.closeIdleForReconcile();
    if (pool.list().length !== 0) return [];
    return await guard.lock((registry) => {
      if (pool.list().length !== 0)
        throw new Error('Codex cleanup is waiting for running processes to stop.');
      guard.assertGone(registry);
      const removed: string[] = [];
      // Re-read under the lock: another launch may have recorded more paths
      // while we waited. Only the private persisted list is authority here.
      const current = readMountTargets(data);
      for (const file of current) {
        const before = removableMountTarget(file);
        if (!before) continue;
        const parent = path.dirname(file);
        if (path.normalize(file) !== file || fs.realpathSync(parent) !== parent)
          throw new Error('Codex cleanup target has a noncanonical parent.');
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        try {
          const opened = fs.fstatSync(fd);
          const now = removableMountTarget(file);
          if (
            fs.realpathSync(parent) !== parent ||
            !now ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            now.dev !== opened.dev ||
            now.ino !== opened.ino ||
            opened.size !== 0 ||
            opened.uid !== process.getuid?.() ||
            !opened.isFile() ||
            opened.nlink !== 1
          )
            throw new Error('Codex cleanup target changed.');
          fs.unlinkSync(file);
          removed.push(file);
        } finally {
          fs.closeSync(fd);
        }
      }
      const keep = current.filter((file) => {
        try {
          fs.lstatSync(file);
          return true;
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
            return false;
          throw error;
        }
      });
      writeMountTargets(data, keep);
      return removed;
    });
  } catch {
    // A busy or uncertain cleanup is never authority to remove files. The
    // renderer retains each blocking file's read-only/deny protection.
    logger.debug('[Codex] mount cleanup deferred');
    return [];
  }
}
