/**
 * Startup janitor for crash-left marketplace install backups.
 *
 * The transaction engine (`./transaction.ts`) moves an existing install
 * target aside to a sibling `<target>.dorkos-bak-<timestamp>-<uuid>` backup
 * before activation, and removes it on both the success and the failure
 * path (ADR-0304). A hard crash between the move-aside and either cleanup
 * path skips both, leaving the backup on disk forever. Worse, until DOR-175
 * the mesh unified scanner had no exclusion for `*.dorkos-bak-*` paths, so a
 * crash-left agent backup could resurface as a phantom duplicate agent (the
 * scanner-side half of that fix lives in
 * `packages/mesh/src/discovery/unified-scanner.ts`).
 *
 * {@link sweepStaleInstallBackups} runs once at server startup (mirroring
 * the `ActivityService.prune()` call in `index.ts`) and removes only
 * backups whose *name-embedded* timestamp is older than `maxAgeMs`. The
 * timestamp is parsed from the directory name — never the directory's `fs`
 * mtime — because `moveTargetAside` renames a pre-existing target onto the
 * backup path, and a rename does not update a directory's mtime (it reflects
 * whenever the target's *contents* last changed, which predates the backup
 * event and could be arbitrarily old even for a backup created moments ago
 * by a transaction that is still running). The name-embedded `Date.now()`
 * is the only trustworthy "when was this backup created" signal, and it is
 * exactly the liveness guard this sweep needs: `runTransaction` holds a
 * backup only for the duration of `activate` (milliseconds to low seconds),
 * so any backup whose embedded timestamp is older than the (generous,
 * default 24h) threshold cannot belong to an in-flight transaction — it can
 * only be crash residue.
 *
 * @module services/marketplace/backup-janitor
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { BACKUP_SUFFIX } from './transaction.js';

/** Default staleness threshold: backups older than this are swept. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Global-scope roots every install flow writes into (`install-plugin.ts`,
 * `install-agent.ts`, `install-skill-pack.ts`, `install-adapter.ts` all
 * compute their `target` under one of these two directories for a global
 * install). A crash-left backup is always a direct sibling of its target,
 * so a single non-recursive `readdir` of each root is sufficient — no need
 * to walk the tree.
 *
 * Project-local installs (`--project <path>`) place their target under
 * `<projectPath>/.dork/plugins/<name>` or, for agents, `<projectPath>`
 * itself — locations that vary per project and are not enumerable here.
 * Those backups are not swept by this janitor, but they can never surface
 * as phantom agents/packages either, because the scanner-side exclusion in
 * `packages/mesh/src/discovery/unified-scanner.ts` is unconditional and
 * location-agnostic.
 */
const GLOBAL_SCOPE_ROOTS = ['plugins', 'agents'] as const;

/**
 * Sweep stale `*.dorkos-bak-*` install backups under `<dorkHome>/plugins/`
 * and `<dorkHome>/agents/`.
 *
 * Best-effort throughout: a missing root (fresh `dorkHome`, nothing
 * installed yet), an unreadable directory, an unparseable backup name, or a
 * failed removal are all logged and skipped rather than thrown, so one bad
 * entry never aborts the sweep and a sweep failure never blocks server
 * startup.
 *
 * @param dorkHome - Resolved DorkOS data directory (see `lib/dork-home.ts`).
 * @param logger - Logger for diagnostic output.
 * @param opts - `maxAgeMs` overrides the default 24h staleness threshold
 *   (test hook; production callers should rely on the default).
 * @returns The number of backup directories removed.
 */
export async function sweepStaleInstallBackups(
  dorkHome: string,
  logger: Logger,
  opts?: { maxAgeMs?: number }
): Promise<number> {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const scope of GLOBAL_SCOPE_ROOTS) {
    const root = path.join(dorkHome, scope);
    removed += await sweepRoot(root, cutoff, logger);
  }

  return removed;
}

/**
 * Sweep one global-scope root (non-recursive). Returns the number of
 * backups removed from this root.
 *
 * @internal
 */
async function sweepRoot(root: string, cutoff: number, logger: Logger): Promise<number> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await _internal.readEntries(root);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`[marketplace/backup-janitor] failed to read ${root}: ${errMessage(err)}`);
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes(BACKUP_SUFFIX)) continue;

    const timestamp = parseBackupTimestamp(entry.name);
    if (timestamp === undefined) {
      // Unrecognized shape of an otherwise-matching name — leave it alone
      // rather than guess at its age. Demonstrable staleness is the bar.
      logger.warn(`[marketplace/backup-janitor] skipping unparseable backup name: ${entry.name}`);
      continue;
    }
    if (timestamp >= cutoff) continue; // Not stale — may be a live transaction.

    const backupPath = path.join(root, entry.name);
    try {
      await _internal.removeBackup(backupPath);
      removed++;
      logger.info(`[marketplace/backup-janitor] removed stale install backup: ${backupPath}`);
    } catch (err) {
      logger.warn(
        `[marketplace/backup-janitor] failed to remove stale backup ${backupPath}: ${errMessage(err)}`
      );
    }
  }
  return removed;
}

/**
 * Parse the `Date.now()` embedded in a backup directory name
 * (`<target-basename>.dorkos-bak-<timestamp>-<uuid>`, written by
 * `transaction.ts`'s `moveTargetAside`). Returns `undefined` when the name
 * contains {@link BACKUP_SUFFIX} but the segment that follows does not start
 * with the expected `<digits>-` shape.
 *
 * @internal
 */
function parseBackupTimestamp(entryName: string): number | undefined {
  const idx = entryName.lastIndexOf(BACKUP_SUFFIX);
  if (idx === -1) return undefined;
  const rest = entryName.slice(idx + BACKUP_SUFFIX.length);
  const match = /^(\d+)-/.exec(rest);
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : undefined;
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
 * List a directory's entries with file-type info attached.
 *
 * @internal
 */
async function readEntries(dir: string): Promise<import('node:fs').Dirent<string>[]> {
  return (await readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent<string>[];
}

/**
 * Recursively remove a backup directory.
 *
 * @internal
 */
async function removeBackup(backupPath: string): Promise<void> {
  await rm(backupPath, { recursive: true, force: true });
}

/**
 * @internal Test-only export. The supported API is
 * {@link sweepStaleInstallBackups}; these helpers are exposed only so tests
 * can stub filesystem interactions with `vi.spyOn` — mirrors the
 * `_internal` pattern in `./transaction.ts`, which sidesteps the "cannot
 * spy on a `node:fs/promises` named export" ESM limitation.
 */
export const _internal = {
  readEntries,
  removeBackup,
};
