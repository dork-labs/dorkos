/**
 * Finds the Claude account folders on this computer that DorkOS does not know
 * about yet, for Settings' "Found on this computer" list (spec
 * `claude-account-ui` §6.9, §7.4). Nothing here registers anything: the list is
 * an offer, and a folder becomes an account only when a person clicks Add.
 *
 * It follows flow's `flow accounts setup` detection (marketplace
 * `plugins/flow/scripts/fleet/detect-accounts.ts`), so the two agree on what an
 * account folder is, with three differences on purpose:
 *
 * - **`projects/` is required.** Flow also accepts a folder holding only
 *   `sessions/`. DorkOS's own check for a usable account folder looks at
 *   `projects/`, so a `sessions/`-only folder would read "not ready" right
 *   after Add.
 * - **`CLAUDE_CONFIG_DIR` is not read.** The server resolves accounts from its
 *   config, never from its own environment.
 * - **`lastUsedAt` and the dismissed list exist only here.** Flow needs neither.
 *
 * **Stat and readdir only.** Nothing in this module opens a file, so it never
 * reads an account's settings or its sign-in. The org marker is a file's
 * EXISTENCE, as in flow.
 *
 * It never learns the OS home folder. The Hard Rule 3 carve-out
 * (`claude-config-dir.ts`) hands it the `.claude*` folders, the comparable
 * form of a folder and the machine default folder; tests pass `deps` (a
 * candidate list and a temp home), so nothing here scans a real home under test.
 *
 * @module services/runtimes/claude-code/accounts/found-claude-folders
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FoundClaudeFolder } from '@dorkos/shared/account-usage';
import {
  canonicalAccountPath,
  defaultAccountFolder,
} from '../../../core/usage/runtime-accounts.js';
import {
  canonicalClaudeAccountPath,
  claudeDefaultAccountFolder,
  listClaudeAccountFolderCandidates,
} from '../claude-config-dir.js';

/**
 * The files Claude Code leaves in an account folder when an organization
 * manages it: its cache of server-managed settings, and org policy limits.
 * Flow's `ORG_MARKER_FILES`, spelled identically so the two flag the same folders.
 */
export const ORG_MARKER_FILES = ['remote-settings.json', 'policy-limits.json'] as const;

/** The most folders `runtimes.claudeCode.dismissedFolders` keeps (the schema's `max`). */
export const MAX_DISMISSED_FOLDERS = 200;

/** The most entries one folder's last-use scan stats, so a huge history stays cheap. */
const MAX_STATS_PER_FOLDER = 2_000;

/**
 * What the finder reads besides config, for tests. Without it the finder asks
 * `claude-config-dir.ts`, the only module that may look at the OS home.
 */
export interface FoundFolderDeps {
  /** The `.claude*` folders to consider, as {@link listClaudeAccountFolderCandidates} lists them. */
  candidates: readonly string[];
  /** The home folder, for `~` in config and the machine default folder. */
  home: string;
}

/** How the finder compares folders and finds the default one. */
interface FolderEnv {
  candidates: readonly string[];
  canonical: (dir: string) => string;
  defaultFolder: (config: unknown) => string | null;
}

/** The environment `deps` describes, or the real one from the carve-out. */
function folderEnv(deps: FoundFolderDeps | undefined): FolderEnv {
  if (deps) {
    return {
      candidates: deps.candidates,
      canonical: (dir) => canonicalAccountPath(dir, deps.home),
      defaultFolder: (config) => defaultAccountFolder('claude-code', config, deps.home).path,
    };
  }
  return {
    candidates: listClaudeAccountFolderCandidates(),
    canonical: canonicalClaudeAccountPath,
    defaultFolder: (config) => claudeDefaultAccountFolder(config).path,
  };
}

/** Outcome of {@link planDismissFoundFolder}. */
export type DismissFoundFolderPlan =
  /** Save `dismissed` as `runtimes.claudeCode.dismissedFolders`. */
  | { outcome: 'save'; dismissed: string[] }
  /** Already hidden (registered, the default, or dismissed): nothing to write. */
  | { outcome: 'unchanged' }
  /** Not a folder the list offers. */
  | { outcome: 'not-a-candidate' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored `runtimes.claudeCode` block, or an empty object. */
function claudeCodeSection(config: unknown): Record<string, unknown> {
  const runtimes = isObject(config) ? config.runtimes : undefined;
  const section = isObject(runtimes) ? runtimes.claudeCode : undefined;
  return isObject(section) ? section : {};
}

/** The stored dismissed list, strings only. */
function storedDismissed(config: unknown): string[] {
  const list = claudeCodeSection(config).dismissedFolders;
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Whether `dir` is a folder, following a symlink. */
function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every folder the list must not offer, in comparable form: the machine
 * default folder, every registered row's path (rows the reader skips
 * included, when they carry a path), and every dismissed folder.
 */
function hiddenFolders(config: unknown, env: FolderEnv): Set<string> {
  const hidden = new Set<string>();
  const add = (dir: string) => hidden.add(env.canonical(dir));

  // A `default` that aliases a registered row names that row's folder, which
  // the registered rows below cover; one that stands alone is its own account.
  const machineDefault = env.defaultFolder(config);
  if (machineDefault !== null) add(machineDefault);

  const rows = claudeCodeSection(config).accounts;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (isObject(row) && typeof row.path === 'string' && row.path.length > 0) add(row.path);
    }
  }
  for (const dir of storedDismissed(config)) add(dir);
  return hidden;
}

/** The org marker file `dir` holds, or `null`. */
function orgMarkerOf(dir: string): string | null {
  for (const file of ORG_MARKER_FILES) {
    try {
      if (fs.statSync(path.join(dir, file)).isFile()) return file;
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * When the account in `dir` was last used: the newest modification time
 * among `projects/`, its direct children and the files directly inside each
 * child. A resumed session appends to a file that already exists, which a
 * folder's own time misses, so the files are what catch it. At most
 * {@link MAX_STATS_PER_FOLDER} entries are statted; the newest found wins.
 */
function lastUsedAt(dir: string): string | null {
  const projects = path.join(dir, 'projects');
  let budget = MAX_STATS_PER_FOLDER;
  let newest = -Infinity;
  const statMtime = (entry: string): fs.Stats | null => {
    if (budget <= 0) return null;
    budget -= 1;
    try {
      const stats = fs.statSync(entry);
      newest = Math.max(newest, stats.mtimeMs);
      return stats;
    } catch {
      return null;
    }
  };
  const list = (folder: string): string[] => {
    try {
      return fs.readdirSync(folder);
    } catch {
      return [];
    }
  };

  statMtime(projects);
  for (const child of list(projects)) {
    if (budget <= 0) break;
    const childPath = path.join(projects, child);
    const stats = statMtime(childPath);
    if (!stats?.isDirectory()) continue;
    for (const entry of list(childPath)) {
      if (budget <= 0) break;
      statMtime(path.join(childPath, entry));
    }
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
}

/** The candidates that hold a `projects/` folder, each real folder once. */
function candidateFolders(env: FolderEnv): { dir: string; canonical: string }[] {
  const seen = new Set<string>();
  const out: { dir: string; canonical: string }[] = [];
  for (const dir of env.candidates) {
    if (!isFolder(dir) || !isFolder(path.join(dir, 'projects'))) continue;
    // A symlink and its target are one folder; the first by name is kept.
    const canonical = env.canonical(dir);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ dir, canonical });
  }
  return out;
}

/**
 * The Claude account folders on this computer that are not registered, not
 * the machine default and not dismissed, sorted by folder name.
 *
 * @param config - The parsed config (at least its `runtimes` section).
 * @param deps - For tests: the candidate folders and a home. Default: this computer.
 * @returns The folders to offer; empty when there is nothing new.
 */
export function findUnregisteredClaudeFolders(
  config: unknown,
  deps?: FoundFolderDeps
): FoundClaudeFolder[] {
  return findWith(config, folderEnv(deps));
}

function findWith(config: unknown, env: FolderEnv): FoundClaudeFolder[] {
  const hidden = hiddenFolders(config, env);
  return candidateFolders(env)
    .filter(({ canonical }) => !hidden.has(canonical))
    .map(({ dir }) => {
      const orgMarker = orgMarkerOf(dir);
      return {
        path: dir,
        name: path.basename(dir),
        lastUsedAt: lastUsedAt(dir),
        orgManaged: orgMarker !== null,
        orgMarker,
      };
    });
}

/**
 * What dismissing `dir` from the found list writes (spec `claude-account-ui`
 * §7.4). The stored list plus `dir` in comparable form, when `dir` is a folder
 * the list offers; nothing when it is already hidden (another tab added or
 * dismissed it a moment ago, a harmless race); a refusal otherwise.
 *
 * The list keeps the newest {@link MAX_DISMISSED_FOLDERS}: past that, the
 * oldest dismissal is the one let go, so the newest click always sticks.
 *
 * @param dir - The folder, as the found list gave it.
 * @param config - The parsed config, read just before the write.
 * @param deps - For tests: the candidate folders and a home. Default: this computer.
 */
export function planDismissFoundFolder(
  dir: string,
  config: unknown,
  deps?: FoundFolderDeps
): DismissFoundFolderPlan {
  const env = folderEnv(deps);
  const canonical = env.canonical(dir);
  if (hiddenFolders(config, env).has(canonical)) return { outcome: 'unchanged' };
  const offered = findWith(config, env).some((folder) => env.canonical(folder.path) === canonical);
  if (!offered) return { outcome: 'not-a-candidate' };
  return {
    outcome: 'save',
    dismissed: [...storedDismissed(config), canonical].slice(-MAX_DISMISSED_FOLDERS),
  };
}
