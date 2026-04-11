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
import type { DiscoveryStrategy } from '../discovery-strategy.js';
import { readManifest } from '../manifest.js';
import type { ScanEvent, ScanProgress, UnifiedScanOptions } from './types.js';
import { UNIFIED_EXCLUDE_PATTERNS } from './types.js';

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

      // Check for existing .dork/agent.json — auto-import, then continue BFS
      const manifest = await readManifest(dir);
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

      // Apply strategies if not already registered
      if (!registry.isRegistered(dir)) {
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

      // Enqueue subdirectories if within depth limit
      if (depth < maxDepth) {
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
