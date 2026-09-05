#!/usr/bin/env node
/**
 * ADR staleness scanner — the heavier, on-demand companion to adr-drift-check.mjs.
 *
 * Where the drift check validates manifest/file integrity (hook-fast, every
 * session), this scans the repo for signals that an ADR's *content* or *status*
 * no longer matches reality:
 *
 *   - stale citations   source/docs lines citing an ADR whose status is
 *                       superseded/deprecated/rejected, an archived ADR, or an
 *                       id that does not exist at all
 *   - dead paths        accepted ADRs whose backtick-quoted repo paths no
 *                       longer exist on disk (a weak but free rot signal)
 *   - unverified age    accepted ADRs whose manifest `lastVerified` is missing
 *                       or older than --max-age-days (default 120)
 *
 * The scanner cannot judge whether a decision still *holds* — that requires
 * reading the code, which is /adr:audit's agent fan-out. Its job is to build
 * the audit worklist and to catch the mechanical lies cheaply.
 *
 * Usage:
 *   node .claude/scripts/adr-staleness-scan.mjs             # human report
 *   node .claude/scripts/adr-staleness-scan.mjs --json      # worklist for /adr:audit
 *   node .claude/scripts/adr-staleness-scan.mjs --max-age-days=90
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keyOf, normalizeKey } from './adr-drift-check.mjs';

/**
 * Matches `ADR-0027`, `ADR 260711-154514`, and `decisions/0304-…` citations.
 * The lookahead rejects partial matches inside longer ids and wildcard
 * citations like `ADR 260711-*` (a legitimate cite-the-family style).
 */
export const CITATION_RE = /\b(?:ADR[- ]?|decisions\/)(\d{6}-\d{6}|\d{4})(?!\d|-\d)/g;

/** Directories that are historical records or generated output — never scanned. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.temp',
  '.turbo',
  'worktrees',
  'fixtures',
  'test-results',
  'playwright-report',
  'archive',
]);

/** Roots whose ADR citations are live guidance (specs/ and research/ are history). */
const SCAN_ROOTS = [
  'apps',
  'packages',
  'scripts',
  'contributing',
  'docs',
  '.claude/rules',
  '.claude/skills',
  '.claude/commands',
  '.claude/hooks',
  'AGENTS.md',
  'README.md',
  'REVIEW.md',
];

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.mdx', '.sh']);

/** The checkers' own pin suite must contain fake/stale citations as fixtures. */
const SKIP_FILES = new Set(['adr-corpus-checks.test.ts']);

/**
 * Recursively collect scannable files under a root, skipping generated dirs.
 * Directories dedupe by realpath so symlinked trees (all of `.claude/skills`)
 * are read once and a link cycle cannot hang the scan.
 */
export function walkFiles(root, out = [], seenDirs = new Set()) {
  if (!existsSync(root)) return out;
  const stat = statSync(root);
  if (stat.isFile()) {
    const ext = root.slice(root.lastIndexOf('.'));
    if (SCAN_EXTS.has(ext)) out.push(root);
    return out;
  }
  const real = realpathSync(root);
  if (seenDirs.has(real)) return out;
  seenDirs.add(real);
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    walkFiles(join(root, name), out, seenDirs);
  }
  return out;
}

/**
 * Find citations of ADRs that a reader should no longer follow.
 *
 * @param files - Absolute file paths to scan
 * @param statusByKey - Map of ADR key → manifest status
 * @param archivedKeys - Keys of ADRs living in decisions/archive/
 * @returns One record per stale citation with the reason it is stale
 */
export function findStaleCitations(files, statusByKey, archivedKeys) {
  const stale = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let lineNo = 0;
    for (const line of text.split('\n')) {
      lineNo += 1;
      for (const match of line.matchAll(CITATION_RE)) {
        const key = normalizeKey(match[1]);
        const status = statusByKey.get(key);
        if (status === 'superseded' || status === 'deprecated' || status === 'rejected') {
          stale.push({ file, line: lineNo, key, reason: status });
        } else if (!status) {
          stale.push({
            file,
            line: lineNo,
            key,
            reason: archivedKeys.has(key) ? 'archived' : 'missing',
          });
        }
      }
    }
  }
  return stale;
}

/** Repo-path prefixes that make a backtick-quoted string checkable on disk. */
const PATH_RE = /^(apps|packages|scripts|docs|contributing|decisions|specs|meta|\.claude|src)\//;
const SRC_PREFIXES = [
  'apps/client/',
  'apps/server/',
  'apps/site/',
  'apps/desktop/',
  'apps/obsidian-plugin/',
];

/**
 * Check an accepted ADR's cited repo paths against the working tree.
 *
 * @returns Null when every cited path resolves, else the dead-path record
 */
export function findDeadPaths(body, repoRoot) {
  const cited = [...body.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((s) => /^[\w@./-]+$/.test(s) && PATH_RE.test(s));
  if (cited.length === 0) return null;
  const dead = cited.filter((p) => {
    if (existsSync(join(repoRoot, p))) return false;
    if (p.startsWith('src/')) {
      return !SRC_PREFIXES.some((prefix) => existsSync(join(repoRoot, prefix + p)));
    }
    return true;
  });
  return dead.length > 0 ? { dead, total: cited.length } : null;
}

/**
 * Build the audit worklist: every accepted ADR, load-bearing first (citation
 * count descending), then oldest-unverified first.
 *
 * @param entries - Manifest decision entries
 * @param citationCounts - Map of ADR key → live citation count
 * @param deadPathsByKey - Map of ADR key → dead-path record
 * @param maxAgeDays - Verification age beyond which an ADR needs re-audit
 * @param now - Current time in ms (injectable for tests)
 */
export function buildWorklist(entries, citationCounts, deadPathsByKey, maxAgeDays, now) {
  const cutoff = now - maxAgeDays * 86_400_000;
  const items = entries
    .filter((d) => d.status === 'accepted')
    .map((d) => {
      const key = keyOf(d);
      const verifiedAt = d.lastVerified ? Date.parse(d.lastVerified) : null;
      return {
        key,
        slug: d.slug,
        title: d.title,
        created: d.created,
        lastVerified: d.lastVerified ?? null,
        needsAudit: verifiedAt == null || verifiedAt < cutoff,
        citations: citationCounts.get(key) ?? 0,
        deadPaths: deadPathsByKey.get(key)?.dead ?? [],
      };
    })
    .filter((item) => item.needsAudit);
  items.sort((a, b) => b.citations - a.citations || a.created.localeCompare(b.created));
  return items;
}

/** Assemble every signal for a repo; the shared core of both CLI modes. */
export function scan(repoRoot, { maxAgeDays = 120, now = Date.now() } = {}) {
  const decisionsDir = join(repoRoot, 'decisions');
  const manifest = JSON.parse(readFileSync(join(decisionsDir, 'manifest.json'), 'utf8'));
  const entries = manifest.decisions || [];
  const statusByKey = new Map(entries.map((d) => [keyOf(d), d.status]));

  const archiveDir = join(decisionsDir, 'archive');
  const archivedKeys = new Set(
    (existsSync(archiveDir) ? readdirSync(archiveDir) : [])
      .map((f) => /^(\d{4}|\d{6}-\d{6})-/.exec(f)?.[1])
      .filter(Boolean)
  );

  const files = SCAN_ROOTS.flatMap((root) => walkFiles(join(repoRoot, root)));
  const staleCitations = findStaleCitations(files, statusByKey, archivedKeys).map((c) => ({
    ...c,
    file: relative(repoRoot, c.file),
  }));

  const citationCounts = new Map();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(CITATION_RE)) {
      const key = normalizeKey(match[1]);
      citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1);
    }
  }

  const deadPathsByKey = new Map();
  for (const entry of entries) {
    if (entry.status !== 'accepted') continue;
    const key = keyOf(entry);
    const file = join(decisionsDir, `${key}-${entry.slug}.md`);
    if (!existsSync(file)) continue;
    const result = findDeadPaths(readFileSync(file, 'utf8'), repoRoot);
    if (result) deadPathsByKey.set(key, result);
  }

  const worklist = buildWorklist(entries, citationCounts, deadPathsByKey, maxAgeDays, now);
  const acceptedCount = entries.filter((d) => d.status === 'accepted').length;
  return { staleCitations, deadPathsByKey, worklist, acceptedCount };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const maxAgeFlag = process.argv.find((a) => a.startsWith('--max-age-days='));
  const maxAgeDays = maxAgeFlag ? Number(maxAgeFlag.split('=')[1]) : 120;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error(`invalid --max-age-days: ${maxAgeFlag}`);
    process.exit(1);
  }
  const { staleCitations, deadPathsByKey, worklist } = scan(repoRoot, { maxAgeDays });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ staleCitations, worklist }, null, 2));
    process.exit(0);
  }

  console.log(`ADR staleness scan (max verification age: ${maxAgeDays}d)\n`);
  console.log(
    `Stale citations (source citing superseded/deprecated/archived/missing ADRs): ${staleCitations.length}`
  );
  const byKey = new Map();
  for (const c of staleCitations) {
    const group = byKey.get(c.key) ?? { reason: c.reason, files: new Set() };
    group.files.add(c.file);
    byKey.set(c.key, group);
  }
  for (const [key, group] of [...byKey.entries()].sort(
    (a, b) => b[1].files.size - a[1].files.size
  )) {
    console.log(`  ADR-${key} [${group.reason}] cited in ${group.files.size} file(s)`);
  }
  console.log(`\nAccepted ADRs citing dead paths: ${deadPathsByKey.size}`);
  for (const [key, r] of deadPathsByKey) {
    console.log(`  ADR-${key}: ${r.dead.length}/${r.total} dead — e.g. ${r.dead[0]}`);
  }
  console.log(`\nAudit worklist (accepted, unverified in ${maxAgeDays}d): ${worklist.length}`);
  console.log('Top 10 by citation weight:');
  for (const item of worklist.slice(0, 10)) {
    console.log(`  ADR-${item.key} (${item.citations} citations) ${item.slug}`);
  }
  console.log('\nRun /adr:audit to work through the list.');
  process.exit(0);
}
