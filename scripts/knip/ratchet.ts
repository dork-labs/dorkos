/** One stable finding and its multiplicity. Source positions are excluded. */
export type IssueCounts = Record<string, number>;

/** One way measured findings can differ from their allowed baseline. */
interface Finding {
  /** Whether an issue appeared, grew or needs its baseline lowered. */
  kind: 'new' | 'grew' | 'stale';
  /** Stable issue identity. */
  key: string;
}

const TYPES = new Set([
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
  'catalog',
  'catalogReferences',
  'cycles',
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function symbol(value: unknown): string[] {
  if (!object(value) || typeof value.name !== 'string') throw new Error('Invalid knip symbol');
  return ['name', 'namespace', 'kind', 'specifier'].map((field) => {
    const v = value[field];
    if (v !== undefined && typeof v !== 'string') throw new Error(`Invalid knip ${field}`);
    return (v as string | undefined) ?? '';
  });
}

/** Parse knip JSON into position-independent identities, preserving repeated findings. */
export function normalizeReport(doc: unknown): IssueCounts {
  if (!object(doc) || !Array.isArray(doc.issues))
    throw new Error('Knip report has no issues array');
  const counts: IssueCounts = {};
  for (const row of doc.issues) {
    if (!object(row) || typeof row.file !== 'string' || !row.file)
      throw new Error('Invalid knip file');
    for (const [type, items] of Object.entries(row)) {
      if (type === 'file' || type === 'owners') continue;
      if (!TYPES.has(type) || !Array.isArray(items))
        throw new Error(`Unknown knip issue shape: ${type}`);
      for (const item of items) {
        const symbols =
          type === 'duplicates' || type === 'cycles'
            ? Array.isArray(item) && item.length
              ? item.map(symbol).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
              : null
            : symbol(item);
        if (!symbols) throw new Error(`Invalid grouped knip issue: ${type}`);
        const key = JSON.stringify([type, row.file, symbols]);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** Compare measured findings with the ratchet's allowed findings. */
export function compare(current: IssueCounts, baseline: IssueCounts): Finding[] {
  const findings: Finding[] = [];
  for (const [key, count] of Object.entries(current)) {
    const held = baseline[key];
    if (held === undefined) findings.push({ kind: 'new', key });
    else if (count > held) findings.push({ kind: 'grew', key });
    else if (count < held) findings.push({ kind: 'stale', key });
  }
  for (const key of Object.keys(baseline)) {
    if (current[key] === undefined) findings.push({ kind: 'stale', key });
  }
  return findings;
}

/** Lower the existing allowances without adding any new ones. */
export function lower(current: IssueCounts, baseline: IssueCounts): IssueCounts {
  return Object.fromEntries(
    Object.entries(baseline)
      .filter(([key]) => current[key] !== undefined)
      .map(([key, held]) => [key, Math.min(current[key]!, held)])
  );
}

/** Read a versioned baseline or fail rather than assuming a clean tree. */
export function parseBaseline(text: string): { version: 1; issues: IssueCounts } {
  const doc: unknown = JSON.parse(text);
  if (!object(doc) || doc.version !== 1 || !object(doc.issues))
    throw new Error('Invalid knip baseline');
  for (const count of Object.values(doc.issues)) {
    if (!Number.isSafeInteger(count) || (count as number) <= 0)
      throw new Error('Invalid knip allowance');
  }
  return { version: 1, issues: doc.issues as IssueCounts };
}

/** The subprocess result needed to distinguish findings from a failed analyzer. */
interface KnipResult {
  /** Zero means clean, one means findings; every other result is a tool failure. */
  status: number | null;
  /** The JSON reporter output. */
  stdout: string;
  /** Diagnostics printed outside the JSON report. */
  stderr: string;
}

function execute(root: string): KnipResult {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../node_modules/knip/bin/knip.js', import.meta.url)),
      '--production',
      '--reporter=json',
      '--no-progress',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}

/** Run knip at a process edge and refuse incomplete execution. */
export function readKnip(root: string, run: (root: string) => KnipResult = execute): IssueCounts {
  const result = run(root);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `Knip could not complete (exit ${result.status}): ${String(result.stderr ?? '').slice(0, 2000)}`
    );
  }
  const counts = normalizeReport(JSON.parse(result.stdout));
  if (result.status === 1 && Object.keys(counts).length === 0)
    throw new Error('Knip failed without findings');
  return counts;
}
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
