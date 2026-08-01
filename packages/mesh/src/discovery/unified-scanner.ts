/**
 * Unified async BFS scanner for agent discovery.
 *
 * Combines strategy-based candidate detection, auto-import of existing manifests,
 * progress reporting, timeout-based early termination, and symlink cycle detection.
 *
 * @module mesh/discovery/unified-scanner
 */
import fs from 'fs/promises';
import path from 'path';
import type { DiscoveryStrategy } from '../types.js';
import { readManifest, MANIFEST_DIR, MANIFEST_FILE } from '../manifest.js';
import type { ScanEvent, ScanProgress, UnifiedScanOptions } from './types.js';
import { UNIFIED_EXCLUDE_PATTERNS, BACKUP_DIR_MARKER } from './types.js';

/** Minimal interface for checking if a path is already registered. */
export interface RegistryLike {
  isRegistered(projectPath: string): boolean;
}

/** Minimal interface for checking if a path is denied. */
export interface DenialListLike {
  isDenied(projectPath: string): boolean;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL = 100;

/**
 * Dot-directories allowed during traversal because they are relevant to agent detection.
 * All other dot-directories are skipped.
 */
const ALLOWED_DOT_DIRS = new Set([
  '.claude',
  '.cursor',
  '.codex',
  '.dork',
  '.windsurf',
  '.gemini',
  '.cline',
  '.clinerules',
  '.roo',
  '.amazonq',
  '.continue',
  '.augment',
  '.aiassistant',
  '.kilocode',
  '.trae',
]);

/**
 * Whether a directory holds a `.dork/agent.json` FILE — the gate on whether it
 * may be offered as a new-agent candidate.
 *
 * Deliberately not `readManifest`, whose `null` means both "no manifest" and
 * "a manifest that will not parse". The second must NOT reopen the Register
 * affordance: that would overwrite a git-tracked file with a fresh id rather
 * than fixing it.
 *
 * A read error that is not `ENOENT`/`ENOTDIR` answers **yes**, on the same
 * errno discipline the relocation guard uses: a directory whose `.dork/` cannot
 * be stat'd may well hold a manifest, and offering it as a fresh agent is the
 * irreversible direction to be wrong in.
 *
 * @param dir - The directory being walked.
 */
async function manifestFileExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dir, MANIFEST_DIR, MANIFEST_FILE))).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/**
 * Unified async BFS scanner for agent discovery.
 *
 * Yields `ScanEvent` objects as directories are traversed. Combines strategy-based
 * candidate detection, auto-import of existing manifests, progress reporting,
 * and timeout-based early termination.
 *
 * @param options - Scan configuration
 * @param strategies - Discovery strategies to apply at each directory
 * @param registry - Registry for filtering already-registered paths
 * @param denialList - Denial list for filtering rejected paths
 */
export async function* unifiedScan(
  options: UnifiedScanOptions,
  strategies: DiscoveryStrategy[],
  registry: RegistryLike,
  denialList: DenialListLike
): AsyncGenerator<ScanEvent> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const followSymlinks = options.followSymlinks ?? false;
  const extraExcludes = new Set(options.extraExcludes ?? []);
  const { logger } = options;

  logger?.info('[mesh] unified-scanner: starting', {
    root: options.root,
    maxDepth,
    timeoutMs,
    followSymlinks,
    strategyCount: strategies.length,
  });

  const progress: ScanProgress = { scannedDirs: 0, foundAgents: 0 };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  // Realpath-based cycle detection for symlinks
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: options.root, depth: 0 }];

  try {
    while (queue.length > 0) {
      if (timedOut) {
        logger?.info('[mesh] unified-scanner: timed out', progress);
        yield { type: 'complete', data: { ...progress, timedOut: true } };
        return;
      }

      const item = queue.shift();
      if (!item) continue;
      const { dir, depth } = item;

      const dirName = path.basename(dir);

      // Skip excluded directories
      if (UNIFIED_EXCLUDE_PATTERNS.has(dirName) || extraExcludes.has(dirName)) continue;

      // Skip crash-left marketplace install backups
      // (`<target>.dorkos-bak-<ts>-<uuid>`) — never agents or packages, and
      // their names vary per install so they can't join the exact-match
      // UNIFIED_EXCLUDE_PATTERNS set above (DOR-175).
      if (dirName.includes(BACKUP_DIR_MARKER)) continue;

      // Skip dot-directories unless they are relevant to agent detection
      if (dirName.startsWith('.') && !ALLOWED_DOT_DIRS.has(dirName)) continue;

      // Symlink cycle detection
      if (followSymlinks) {
        let realDir: string;
        try {
          realDir = await fs.realpath(dir);
        } catch {
          // Broken symlink or ENOENT race — skip
          continue;
        }
        if (visited.has(realDir)) continue;
        visited.add(realDir);
      }

      // Denied paths: skip candidate and do not descend into children
      if (denialList.isDenied(dir)) continue;

      // Check for existing .dork/agent.json — auto-import, then continue BFS.
      //
      // Two questions, deliberately asked separately. "Is there a manifest FILE
      // here" decides whether this directory may be offered as a new-agent
      // candidate below; "does it parse" decides whether it can be imported.
      // `readManifest` answers `null` to both absent and invalid, and collapsing
      // them here is what let a corrupt manifest surface as a fresh candidate.
      const hasManifest = await manifestFileExists(dir);
      // The logger is passed so a present-but-invalid manifest names itself in
      // the scan's own log. Without it those warnings went to the console, where
      // an operator running the server never sees them — and the recovery
      // (fix or delete the file) is unguessable without the path.
      const manifest = hasManifest ? await readManifest(dir, logger) : null;
      if (manifest) {
        progress.foundAgents++;
        yield { type: 'auto-import', data: { manifest, path: dir } };
      }

      // Read directory entries — catch permission errors gracefully
      let entries: import('node:fs').Dirent<string>[];
      try {
        entries = (await fs.readdir(dir, {
          withFileTypes: true,
        })) as import('node:fs').Dirent<string>[];
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          logger?.warn(`[mesh] unified-scanner: permission denied reading ${dir}`);
        } else {
          logger?.warn(`[mesh] unified-scanner: error reading ${dir}: ${(err as Error).message}`);
        }
        continue;
      }

      // Apply strategies unless this directory already has an identity.
      //
      // **A manifest-bearing directory is never a candidate, whatever its
      // registration state.** `isRegistered` alone was not enough: a duplicate
      // checkout the relocation guard refuses (ADR 260801-003050) has a manifest
      // and no row, so it surfaced on every scan as a "new agent" whose Register
      // button mints a fresh ULID and OVERWRITES the git-tracked manifest —
      // dirtying a tracked file that would change the primary agent's id if it
      // were merged. Imported, refused, or invalid, this directory already has
      // an identity; someone who wants a clone to be its own agent re-inits it
      // deliberately rather than clicking a scan surface.
      if (!hasManifest && !registry.isRegistered(dir)) {
        for (const strategy of strategies) {
          try {
            if (await strategy.detect(dir)) {
              const hints = await strategy.extractHints(dir);
              yield {
                type: 'candidate',
                data: {
                  path: dir,
                  strategy: strategy.name,
                  hints,
                  discoveredAt: new Date().toISOString(),
                },
              };
              break;
            }
          } catch {
            // Strategy errors are non-fatal — continue to next strategy
          }
        }
      }

      progress.scannedDirs++;

      // Emit progress event every PROGRESS_INTERVAL directories
      if (progress.scannedDirs % PROGRESS_INTERVAL === 0) {
        yield { type: 'progress', data: { ...progress } };
      }

      // Enqueue subdirectories if within depth limit.
      //
      // Sorted, because `fs.readdir` order is filesystem-dependent: the same
      // tree walked twice could yield candidates in two different orders, and
      // before the relocation guard existed that order decided which copy of a
      // duplicated manifest won the agent's identity. Identity is now sticky to
      // the first registrant whatever the order (ADR 260801-003050); sorting is
      // what makes a single traversal reproducible for everything else.
      if (depth < maxDepth) {
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const isDir = entry.isDirectory();
          const isSymlink = entry.isSymbolicLink();

          if (!isDir && !isSymlink) continue; // skip regular files
          if (isSymlink && !followSymlinks) continue; // skip symlinks when not following

          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
    }

    logger?.info('[mesh] unified-scanner: finished', progress);
    yield { type: 'complete', data: { ...progress, timedOut: false } };
  } finally {
    clearTimeout(timer);
  }
}
