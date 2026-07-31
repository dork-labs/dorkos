/**
 * `pnpm doctor:dev` — the contributor's half of the doctor.
 *
 * `dorkos doctor` answers "is this DorkOS install healthy?". This answers "is
 * this *checkout* healthy?" — stale build output, dev servers nobody stopped, a
 * native module rebuilt for Electron. None of those can happen to someone who
 * installed from npm, which is why they are not in the shipped command.
 *
 * Same `CheckResult` type, same renderer, same rule: only a `fail` exits
 * non-zero. Everything it does is read-only.
 *
 * Run from the repo root: `pnpm doctor:dev`.
 *
 * @module scripts/doctor-dev
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '@dorkos/shared/health-schemas';
import {
  checkDistFreshness,
  checkNativeSqlite,
  checkOrphanedWatchers,
  type RunningProcess,
} from '../src/commands/doctor-dev-checks.js';
import { exitCodeFor, printChecklist } from '../src/commands/doctor-render.js';

/** This file lives at `packages/cli/scripts/`, so the repo root is three levels up. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const results: CheckResult[] = [
  ...findDistBackedPackages().map((pkg) =>
    checkDistFreshness({
      packageName: pkg.packageName,
      newestSourceMs: newestMtimeMs(path.join(pkg.directory, 'src')),
      newestDistMs: newestMtimeMs(path.join(pkg.directory, 'dist')),
    })
  ),
  checkOrphanedWatchers(listProcesses()),
  checkNativeSqlite(probeNativeSqlite()),
];

printChecklist('Checking your DorkOS checkout...', results);
process.exitCode = exitCodeFor(results);

/**
 * Find the workspace packages whose consumers read `dist/` rather than `src/`.
 *
 * Derived from each package's own manifest instead of listed here, because a
 * hand-written list goes stale silently and then warns about a package that has
 * no build (`@dorkos/db` is consumed straight from source) or misses one that
 * just gained a dist.
 *
 * @returns One entry per package that builds and is imported through `dist/`.
 */
function findDistBackedPackages(): Array<{ packageName: string; directory: string }> {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const found: Array<{ packageName: string; directory: string }> = [];
  for (const name of fs.readdirSync(packagesDir)) {
    const directory = path.join(packagesDir, name);
    let manifest: { name?: string; scripts?: Record<string, string>; exports?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf-8'));
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.scripts?.build) continue;
    if (!JSON.stringify(manifest.exports ?? {}).includes('./dist/')) continue;
    found.push({ packageName: manifest.name, directory });
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/**
 * The newest modification time of anything under `dir` that the build reads.
 *
 * Tests are skipped. A build emits no output for them, so editing a test made
 * `dist/` look stale forever and told the reader to run a build that would
 * change nothing — the exact false alarm this check exists to avoid.
 *
 * @param dir - The folder to walk.
 * @returns The newest mtime, or `null` when nothing counts.
 */
function newestMtimeMs(dir: string): number | null {
  let newest: number | null = null;
  const isTest = (name: string): boolean =>
    name === '__tests__' ||
    name === '__mocks__' ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /\.test-d\.ts$/.test(name);
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isTest(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = fs.statSync(full);
          if (newest === null || mtimeMs > newest) newest = mtimeMs;
        } catch {
          // Vanished between readdir and stat — it cannot be the newest thing.
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/** Every process this user can see, as pid + command line. Empty on any failure. */
function listProcesses(): RunningProcess[] {
  try {
    const stdout = execFileSync(
      'ps',
      ['-o', 'pid=,command=', '-u', String(process.getuid?.() ?? 0)],
      {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    return stdout
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({ pid: Number(match[1]), command: match[2] ?? '' }));
  } catch {
    return [];
  }
}

/** Load the native SQLite binding the way a test worker would. Returns the error, if any. */
function probeNativeSqlite(): Error | null {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
