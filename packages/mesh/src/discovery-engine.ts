/**
 * Async BFS discovery engine for scanning directories for agent projects.
 *
 * Scans directory trees using breadth-first search with depth limiting,
 * applying registered DiscoveryStrategy instances to detect agent projects.
 * Already-registered paths and denied paths are filtered automatically.
 *
 * @module mesh/discovery-engine
 */
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import type { DiscoveryCandidate, AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from './discovery-strategy.js';
import { readManifest } from './manifest.js';

/** Directories always excluded from BFS traversal. */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.DS_Store',
]);

/**
 * Dot-directories that are allowed during traversal because they are
 * relevant to agent detection (must not be skipped along with other dot dirs).
 */
const ALLOWED_DOT_DIRS = new Set(['.claude', '.cursor', '.codex', '.dork']);

/** Configuration for a directory scan. */
export interface DiscoveryOptions {
  /** Maximum BFS depth from rootDir (default: 5). */
  maxDepth?: number;
  /** Set of directory names to skip during traversal (default: EXCLUDED_DIRS). */
  excludedDirs?: Set<string>;
  /** Whether to follow symbolic links (default: false). */
  followSymlinks?: boolean;
}

/** Emitted when an existing .dork/agent.json manifest is found during scan. */
export interface AutoImportedAgent {
  type: 'auto-import';
  manifest: AgentManifest;
  path: string;
}

/** Minimal interface for filtering already-registered paths. */
export interface RegistryLike {
  getByPath(projectPath: string): { id: string } | undefined;
}

/** Minimal interface for filtering denied paths. */
export interface DenialListLike {
  isDenied(path: string): boolean;
}

/**
 * Scan directories for agent candidates using depth-limited async BFS.
 *
 * Yields either a DiscoveryCandidate (new agent found) or an AutoImportedAgent
 * (existing .dork/agent.json detected). The caller is responsible for handling
 * each yielded value appropriately.
 *
 * @param rootDir - Root directory to start scanning from
 * @param strategies - Discovery strategies to apply at each directory
 * @param registry - Registry for filtering already-registered project paths
 * @param denialList - Denial list for filtering rejected paths
 * @param options - Scan configuration (depth, exclusions, symlinks)
 */
export async function* scanDirectory(
  rootDir: string,
  strategies: DiscoveryStrategy[],
  registry: RegistryLike,
  denialList: DenialListLike,
  options: DiscoveryOptions = {},
): AsyncGenerator<DiscoveryCandidate | AutoImportedAgent> {
  const maxDepth = options.maxDepth ?? 5;
  const excludedDirs = options.excludedDirs ?? EXCLUDED_DIRS;
  const followSymlinks = options.followSymlinks ?? false;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  // realpath-based cycle detection — prevents infinite loops through symlinks
  const visited = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;
    const { dir, depth } = item;

    if (depth > maxDepth) continue;

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      // Can't resolve path (e.g., broken symlink) — skip silently
      continue;
    }

    if (visited.has(realDir)) continue;
    visited.add(realDir);

    // Check for existing .dork/agent.json — auto-import instead of running strategies
    const manifest = await readManifest(dir);
    if (manifest) {
      yield { type: 'auto-import', manifest, path: dir };
      // Don't descend further into a manifested directory
      continue;
    }

    // Filter denied paths
    if (denialList.isDenied(realDir)) continue;

    // Filter already-registered paths
    if (registry.getByPath(realDir)) continue;

    // Run strategies — first match wins
    for (const strategy of strategies) {
      try {
        if (await strategy.detect(dir)) {
          const hints = await strategy.extractHints(dir);
          yield {
            path: dir,
            strategy: strategy.name,
            hints,
            discoveredAt: new Date().toISOString(),
          };
          break;
        }
      } catch {
        // Strategy errors are non-fatal — continue to next strategy
      }
    }

    // Enqueue subdirectories for BFS traversal
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const isDir = entry.isDirectory();
        const isSymlink = entry.isSymbolicLink();

        // Only descend into directories (or symlinks if enabled)
        if (!isDir && !(followSymlinks && isSymlink)) continue;
        if (isSymlink && !followSymlinks) continue;

        // Skip excluded directories (node_modules, .git, etc.)
        if (excludedDirs.has(entry.name)) continue;

        // Skip dot-directories unless they are relevant to agent detection
        if (entry.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(entry.name)) continue;

        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch (err: unknown) {
      // EACCES/EPERM: silently skip inaccessible directories
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') {
        console.warn(`[mesh] discovery: error reading ${dir}: ${(err as Error).message}`);
      }
    }
  }
}
