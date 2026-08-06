/**
 * Hand-authored declarations for adr-staleness-scan.mjs so `scripts/__tests__/`
 * (strict, NodeNext) can import the scanner without an implicit `any`.
 * Keep in sync with the runtime exports — the pin suite exercises every one.
 */
import type { ManifestDecision } from './adr-drift-check.mjs';

export interface StaleCitation {
  file: string;
  line: number;
  key: string;
  reason: 'superseded' | 'deprecated' | 'rejected' | 'archived' | 'missing';
}

export interface DeadPathResult {
  dead: string[];
  total: number;
}

export interface WorklistItem {
  key: string;
  slug: string;
  title?: string;
  created: string;
  lastVerified: string | null;
  needsAudit: boolean;
  citations: number;
  deadPaths: string[];
}

export interface ScanResult {
  staleCitations: StaleCitation[];
  deadPathsByKey: Map<string, DeadPathResult>;
  worklist: WorklistItem[];
  acceptedCount: number;
}

export declare const CITATION_RE: RegExp;
export declare function walkFiles(root: string, out?: string[]): string[];
export declare function findStaleCitations(
  files: string[],
  statusByKey: Map<string, string>,
  archivedKeys: Set<string>
): StaleCitation[];
export declare function findDeadPaths(body: string, repoRoot: string): DeadPathResult | null;
export declare function buildWorklist(
  entries: readonly ManifestDecision[],
  citationCounts: Map<string, number>,
  deadPathsByKey: Map<string, DeadPathResult>,
  maxAgeDays: number,
  now: number
): WorklistItem[];
export declare function scan(
  repoRoot: string,
  opts?: { maxAgeDays?: number; now?: number }
): ScanResult;
