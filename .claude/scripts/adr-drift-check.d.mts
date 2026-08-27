/**
 * Hand-authored declarations for adr-drift-check.mjs so `scripts/__tests__/`
 * (strict, NodeNext) can import the checker without an implicit `any`.
 * Keep in sync with the runtime exports (1:1, whether or not the pin suite
 * imports a given one).
 */

/** One entry in `decisions/manifest.json` → `decisions[]`. */
export interface ManifestDecision {
  id?: string;
  number?: number;
  slug: string;
  title?: string;
  status: string;
  created: string;
  specSlug?: string | null;
  extractedFrom?: string | null;
  supersededBy?: string | number | null;
  supersedes?: string | number | null;
  amends?: string | number | Array<string | number> | null;
  affects?: string[];
  lastVerified?: string;
}

export interface LinkIssue {
  key: string;
  kind:
    'superseded-without-link' | 'dangling' | 'supersedes-live-target' | 'amends-terminal-target';
  field?: string;
  target?: string;
  targetStatus?: string;
}

export interface DriftFindings {
  orphans: Array<{ file: string; key: string }>;
  slugMismatches: Array<{ file: string; key: string; manifestSlug: string }>;
  duplicates: Array<{ file: string; key: string }>;
  missingFiles: ManifestDecision[];
  linkIssues: LinkIssue[];
  frontmatterDrift: Array<{ key: string; field: string; file: string; manifest: string }>;
  cycles: Array<{ key: string; via: string }>;
}

export declare const FILE_RE: RegExp;
export declare function keyOf(entry: Pick<ManifestDecision, 'id' | 'number'>): string;
export declare function normalizeKey(value: unknown): string | null;
export declare function readFrontmatter(text: string): Record<string, string>;
export declare function relationKeys(value: unknown): string[];
export declare function findDrift(decisionsDir: string): DriftFindings;
export declare function formatReport(findings: DriftFindings): string[];
