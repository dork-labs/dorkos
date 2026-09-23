/**
 * The sweep that settles interrupted marketplace installs across whole scopes.
 *
 * Every install transaction leaves a record beside its target while it runs
 * (`./install-recovery.ts` has the grammar and the rules), and settles any
 * record an earlier, interrupted transaction left before it starts. That
 * covers a target someone touches again. This sweep covers the rest: a crash
 * that left a package missing or half-written, which nobody reinstalls
 * because it simply looks gone or broken.
 *
 * It runs at server startup for the global scope (`dorkHome`), before the app
 * serves anything, and again for every registered agent's project once Mesh
 * has reconciled — project installs live under `<projectPath>/.dork/`, which
 * only the registry can enumerate. Any caller can run it for any scope root.
 *
 * It is one sweep over one grammar: each install root is read once (install
 * targets and their records are direct siblings, so there is nothing to walk),
 * every record found names its target, and each target is settled under that
 * target's install lock by {@link recoverInterruptedInstall}. What happens to
 * a record is decided by its kind's row in the recovery policy table, never
 * here, so a new kind of record needs no change to this file.
 *
 * Until DOR-2273 this module deleted any backup older than a day. A backup
 * that old is exactly the one a crash left when the live directory was missing
 * or half-written, so the old sweep destroyed the only good copy of the
 * install.
 *
 * @module services/marketplace/backup-janitor
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import { installRootsUnder } from './lib/install-roots.js';
import { parseInstallRecordName, recoverInterruptedInstall } from './install-recovery.js';
import { withInstallTargetLock } from './transaction.js';

/** What one sweep did, summed over every target it settled. */
export interface InstallSweepSummary {
  /** Interrupted transactions undone: a previous install restored, or a half-written one removed. */
  rolledBack: number;
  /** Leftovers of finished installs deleted. */
  discarded: number;
  /** Targets left alone because another live process may be mid-install on them. */
  inFlight: number;
}

/**
 * Settle every interrupted install under the given scope roots.
 *
 * Best-effort throughout: a missing root (nothing installed yet), an
 * unreadable directory, or a target whose rollback fails is logged and
 * skipped, so one bad entry never aborts the sweep and a sweep failure never
 * blocks server startup. A target that could not be settled keeps its records
 * and is retried by the next sweep or the next install of it.
 *
 * @param scopeRoots - Scope roots to sweep: `dorkHome`, or a project's
 *   `<projectPath>/.dork` (see `projectScopeRoot`). Each one's install roots
 *   (`plugins/`, `agents/`, `shapes/`) are read.
 * @param logger - Logger for what was done and what was skipped.
 * @returns Totals across every target settled.
 */
export async function recoverInterruptedInstalls(
  scopeRoots: readonly string[],
  logger: Logger
): Promise<InstallSweepSummary> {
  const summary: InstallSweepSummary = { rolledBack: 0, discarded: 0, inFlight: 0 };
  for (const scopeRoot of new Set(scopeRoots)) {
    for (const { dir } of installRootsUnder(scopeRoot)) {
      await sweepInstallRoot(dir, summary, logger);
    }
  }
  return summary;
}

/**
 * Settle every target in one install root that has records beside it.
 *
 * @internal
 */
async function sweepInstallRoot(
  root: string,
  summary: InstallSweepSummary,
  logger: Logger
): Promise<void> {
  let names: string[];
  try {
    names = await _internal.readNames(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[marketplace/backup-janitor] failed to read ${root}: ${errMessage(err)}`);
    }
    return;
  }

  const targets = new Set<string>();
  for (const name of names) {
    if (!isInstallSiblingName(name)) continue;
    const parsed = parseInstallRecordName(name);
    if (!parsed) {
      // Carries a marker but not the full grammar: not provably ours, so it
      // is hidden from readers and never touched.
      logger.warn(`[marketplace/backup-janitor] leaving unrecognised entry alone: ${name}`);
      continue;
    }
    targets.add(parsed.targetName);
  }

  for (const targetName of targets) {
    const target = path.join(root, targetName);
    try {
      const report = await withInstallTargetLock(target, () => recoverInterruptedInstall(target));
      if (report.inFlight.length > 0) {
        summary.inFlight++;
        logger.info(
          `[marketplace/backup-janitor] left ${target} alone: another DorkOS app may be installing it right now`
        );
        continue;
      }
      for (const record of report.rolledBack) {
        summary.rolledBack++;
        logger.info(
          record.kind === 'backup'
            ? `[marketplace/backup-janitor] restored ${target} from an interrupted install (${record.path})`
            : `[marketplace/backup-janitor] removed the half-finished install at ${target}`
        );
      }
      summary.discarded += report.discarded.length;
      for (const { record, error } of report.discardFailures) {
        logger.warn(
          `[marketplace/backup-janitor] failed to remove finished install leftovers ${record.path}: ${errMessage(error)}`
        );
      }
    } catch (err) {
      logger.warn(
        `[marketplace/backup-janitor] could not settle the interrupted install at ${target}; it will be retried: ${errMessage(err)}`
      );
    }
  }
}

/**
 * Render an unknown caught value as a log-friendly message.
 *
 * @internal
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * List a directory's entry names.
 *
 * @internal
 */
async function readNames(dir: string): Promise<string[]> {
  return readdir(dir);
}

/**
 * @internal Test-only export. The supported API is
 * {@link recoverInterruptedInstalls}; this is exposed only so tests can fail a
 * directory read with `vi.spyOn` — mirrors the `_internal` pattern in
 * `./transaction.ts`, which sidesteps the "cannot spy on a `node:fs/promises`
 * named export" ESM limitation.
 */
export const _internal = {
  readNames,
};
