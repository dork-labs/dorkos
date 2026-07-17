/**
 * Unified discovery types — events, options, and exclude patterns.
 *
 * @module mesh/discovery/types
 */
import type { DiscoveryCandidate, AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';

/** Events yielded by the unified scanner. */
export type ScanEvent =
  | { type: 'candidate'; data: DiscoveryCandidate }
  | { type: 'auto-import'; data: { manifest: AgentManifest; path: string } }
  | { type: 'progress'; data: ScanProgress }
  | { type: 'complete'; data: ScanProgress & { timedOut: boolean } };

/** Progress counters emitted during a scan. */
export interface ScanProgress {
  scannedDirs: number;
  foundAgents: number;
}

/** Options for the unified scanner. */
export interface UnifiedScanOptions {
  /** Root directory to scan. */
  root: string;
  /** Maximum BFS depth (default: 5). */
  maxDepth?: number;
  /** Scan timeout in ms (default: 30000). */
  timeout?: number;
  /** Follow symlinks with cycle detection (default: false). */
  followSymlinks?: boolean;
  /** Additional exclude patterns beyond the defaults. */
  extraExcludes?: string[];
  /** Logger for warnings. */
  logger?: Logger;
}

/**
 * Unified exclude set — the canonical set of directory names the unified
 * scanner skips while walking for agent projects.
 */
export const UNIFIED_EXCLUDE_PATTERNS = new Set([
  // System / package-manager directories
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
  // Language virtual-environments and caches
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.DS_Store',
  'extensions',
]);

/**
 * Basename fragment marking a crash-left marketplace install backup
 * directory (`<target>.dorkos-bak-<timestamp>-<uuid>`, see ADR-0304 and
 * `apps/server/src/services/marketplace/transaction.ts`). Unlike
 * {@link UNIFIED_EXCLUDE_PATTERNS}, this can't be an exact-match entry in
 * that set because the name varies per install — every directory whose
 * basename *contains* this marker is excluded, regardless of where it sits
 * in the tree. These are never agents or packages, so the exclusion is
 * unconditional (DOR-175).
 */
export const BACKUP_DIR_MARKER = MARKETPLACE_BACKUP_DIR_MARKER;
