import { readdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename } from 'node:path';

/**
 * Filesystem discovery scanner for AI-configured projects.
 *
 * Scans a root directory (typically the home directory) for projects
 * containing AI agent markers (CLAUDE.md, .cursor/, .dork/agent.json, etc.)
 * and yields results as an async generator suitable for SSE streaming.
 *
 * @module services/discovery/discovery-scanner
 */

const execFileAsync = promisify(execFile);

/** Git command timeout in milliseconds. */
const GIT_TIMEOUT_MS = 2000;

/** Progress is emitted every N directories scanned. */
const PROGRESS_INTERVAL = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered project with AI agent markers. */
export interface DiscoveryCandidate {
  path: string;
  name: string;
  markers: string[];
  gitBranch: string | null;
  gitRemote: string | null;
  hasDorkManifest: boolean;
}

/** Periodic progress update during scanning. */
export interface ScanProgress {
  scannedDirs: number;
  foundAgents: number;
}

/** Options controlling the scanner behavior. */
export interface ScanOptions {
  /** Root directory to start scanning from. */
  root: string;
  /** Maximum directory depth to traverse. Defaults to 5. */
  maxDepth?: number;
  /** Overall scan timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

/** Events yielded by the scanner async generator. */
export type ScanEvent =
  | { type: 'candidate'; data: DiscoveryCandidate }
  | { type: 'progress'; data: ScanProgress }
  | { type: 'complete'; data: ScanProgress & { timedOut: boolean } };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Agent marker files/directories to detect. */
export const AGENT_MARKERS = [
  'CLAUDE.md',
  '.claude',
  '.cursor',
  '.github/copilot',
  '.dork/agent.json',
] as const;

/** Directory names to skip during traversal. */
export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'vendor',
  'Library',
  'AppData',
  '.Trash',
  'dist',
  'build',
  '.cache',
  '.npm',
  '.nvm',
  '.local',
  '.cargo',
  '.rustup',
  'go/pkg',
] as const;

/** Set for O(1) lookups of excluded directory names. */
const EXCLUDE_SET = new Set<string>(DEFAULT_EXCLUDE_PATTERNS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a marker exists at the given directory path.
 *
 * @param dirPath - Directory to check
 * @param marker - Relative marker path (e.g. 'CLAUDE.md', '.dork/agent.json')
 */
async function markerExists(dirPath: string, marker: string): Promise<boolean> {
  try {
    await access(join(dirPath, marker));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which agent markers are present in a directory.
 *
 * @param dirPath - Directory to scan for markers
 */
async function detectMarkers(dirPath: string): Promise<string[]> {
  const found: string[] = [];
  const checks = AGENT_MARKERS.map(async (marker) => {
    if (await markerExists(dirPath, marker)) {
      found.push(marker);
    }
  });
  await Promise.all(checks);
  return found;
}

/**
 * Get the current git branch name for a directory.
 *
 * @param dirPath - Directory that may be a git repo
 */
async function getGitBranch(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dirPath, timeout: GIT_TIMEOUT_MS }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the git remote origin URL for a directory.
 *
 * @param dirPath - Directory that may be a git repo
 */
async function getGitRemote(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: dirPath, timeout: GIT_TIMEOUT_MS }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan the filesystem for projects containing AI agent markers.
 *
 * Yields `candidate` events for each discovered project, `progress` events
 * every {@link PROGRESS_INTERVAL} directories, and a final `complete` event
 * with summary counts and a `timedOut` flag.
 *
 * @param options - Scan configuration (root, maxDepth, timeout)
 */
export async function* scanForAgents(options: ScanOptions): AsyncGenerator<ScanEvent> {
  const root = options.root;
  const maxDepth = options.maxDepth ?? 5;
  const timeout = options.timeout ?? 30_000;

  let scannedDirs = 0;
  let foundAgents = 0;
  let timedOut = false;

  const deadline = Date.now() + timeout;

  // BFS queue: [absolutePath, currentDepth]
  const queue: Array<[string, number]> = [[root, 0]];

  while (queue.length > 0) {
    // Check timeout
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    const [dirPath, depth] = queue.shift()!;

    // Check for agent markers in this directory
    const markers = await detectMarkers(dirPath);
    scannedDirs++;

    if (markers.length > 0) {
      const [gitBranch, gitRemote] = await Promise.all([
        getGitBranch(dirPath),
        getGitRemote(dirPath),
      ]);

      foundAgents++;

      const candidate: DiscoveryCandidate = {
        path: dirPath,
        name: basename(dirPath),
        markers,
        gitBranch,
        gitRemote,
        hasDorkManifest: markers.includes('.dork/agent.json'),
      };

      yield { type: 'candidate', data: candidate };
    }

    // Emit progress periodically
    if (scannedDirs % PROGRESS_INTERVAL === 0) {
      yield { type: 'progress', data: { scannedDirs, foundAgents } };
    }

    // Don't recurse deeper than maxDepth
    if (depth >= maxDepth) continue;

    // Read children and enqueue
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') && !isTrackedDotDir(entry.name)) continue;
        if (EXCLUDE_SET.has(entry.name)) continue;

        queue.push([join(dirPath, entry.name), depth + 1]);
      }
    } catch {
      // Permission error or other read failure — skip this directory
    }
  }

  yield {
    type: 'complete',
    data: { scannedDirs, foundAgents, timedOut },
  };
}

/**
 * Dot-directories that should still be traversed because they contain
 * agent markers (e.g. `.dork/agent.json`, `.claude/`, `.cursor/`).
 */
function isTrackedDotDir(name: string): boolean {
  return name === '.dork' || name === '.claude' || name === '.cursor' || name === '.github';
}
