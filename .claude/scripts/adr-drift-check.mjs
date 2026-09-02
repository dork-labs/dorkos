#!/usr/bin/env node
/**
 * ADR drift detector.
 *
 * Compares on-disk decision files against `decisions/manifest.json` and reports
 * integrity drift that the manifest-only checks (session-maintenance.sh,
 * /adr:review) cannot see. Recognizes both id forms (spec merge-conflict-prevention):
 *   - legacy `NNNN-<slug>.md` (frozen 4-digit numbers)
 *   - timestamp `YYMMDD-HHMMSS-<slug>.md` (new coordination-free ids)
 *
 * Findings:
 *   - orphan files          id on disk not present in the manifest
 *   - slug mismatches       id in the manifest but the on-disk file has a different slug
 *   - missing files         manifest entry with no matching on-disk file
 *   - duplicate ids         two on-disk files share the same id (the timestamp
 *                           backstop for the vanishingly rare same-second clash)
 *   - broken links          `superseded` status without a `supersededBy` pointer
 *   - dangling links        supersededBy/supersedes/amends pointing at no known ADR
 *   - contradictions        `supersedes` aimed at a still-live ADR (partial
 *                           replacement should be an `amends` link), or `amends`
 *                           aimed at a superseded/deprecated one
 *   - supersession cycles   A supersededBy B supersededBy A
 *   - frontmatter drift     file frontmatter status / superseded-by disagreeing
 *                           with the manifest entry
 *
 * Deeper, slower corpus checks (dead paths, stale citations, verification age)
 * live in adr-staleness-scan.mjs — run on demand by /adr:audit, never from a hook.
 *
 * Output: prints a concise report ONLY when drift exists (stays silent when clean,
 * so it is safe to call from a SessionStart hook). Always exits 0.
 *
 * Usage: node .claude/scripts/adr-drift-check.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A file id is either a 4-digit legacy number or a YYMMDD-HHMMSS timestamp. */
export const FILE_RE = /^(\d{4}|\d{6}-\d{6})-(.+)\.md$/;

/** The entry's identity: its timestamp id, or a legacy number zero-padded to 4. */
export const keyOf = (d) => d.id ?? String(d.number).padStart(4, '0');

/**
 * Normalize a link value to key form. Manifest links store legacy targets as
 * bare numbers (`29`) and timestamp targets as strings; frontmatter stores
 * everything as strings. Pure-digit values pad to the 4-digit key.
 */
export function normalizeKey(value) {
  if (value == null || value === 'null' || value === '') return null;
  const s = String(value).replace(/^['"]|['"]$/g, '');
  return /^\d{1,4}$/.test(s) ? s.padStart(4, '0') : s;
}

/**
 * Parse the leading `---` frontmatter block into a flat map of scalar fields.
 * Good enough for ADR frontmatter (no nesting, no lists across lines); CRLF
 * files parse the same as LF ones.
 */
export function readFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

/**
 * Normalize a relation value — scalar, `[a, b]` inline list, or manifest
 * array — into a sorted list of keys. Annotations after the id (e.g.
 * `'260726-193526 (Integration half only)'`) reduce to the id.
 */
export function relationKeys(value) {
  if (value == null) return [];
  const parts = Array.isArray(value)
    ? value
    : String(value)
        .replace(/^\[|\]$/g, '')
        .split(',');
  return parts
    .map((part) => {
      const m = /(\d{6}-\d{6}|\d{1,4})/.exec(String(part));
      return m ? normalizeKey(m[1]) : null;
    })
    .filter(Boolean)
    .sort();
}

/**
 * Run every integrity check against a decisions directory.
 *
 * @param decisionsDir - Absolute path to the `decisions/` directory
 * @returns Named finding lists; all empty when the corpus is clean
 */
export function findDrift(decisionsDir) {
  const manifest = JSON.parse(readFileSync(join(decisionsDir, 'manifest.json'), 'utf8'));
  const entries = manifest.decisions || [];
  const byKey = new Map(entries.map((d) => [keyOf(d), d]));

  const fileKeys = new Set();
  const orphans = [];
  const slugMismatches = [];
  const duplicates = [];
  const frontmatterDrift = [];

  for (const file of readdirSync(decisionsDir)) {
    const match = FILE_RE.exec(file);
    if (!match) continue;
    const [, key, slug] = match;

    if (fileKeys.has(key)) {
      duplicates.push({ file, key });
      continue;
    }
    fileKeys.add(key);

    const entry = byKey.get(key);
    if (!entry) {
      orphans.push({ file, key });
      continue;
    }
    if (entry.slug !== slug) {
      slugMismatches.push({ file, key, manifestSlug: entry.slug });
    }

    const fm = readFrontmatter(readFileSync(join(decisionsDir, file), 'utf8'));
    if (fm.status && fm.status !== entry.status) {
      frontmatterDrift.push({ key, field: 'status', file: fm.status, manifest: entry.status });
    }
    const fmLink = normalizeKey(fm['superseded-by']);
    const manifestLink = normalizeKey(entry.supersededBy);
    if (fmLink !== manifestLink) {
      frontmatterDrift.push({
        key,
        field: 'superseded-by',
        file: fmLink ?? 'null',
        manifest: manifestLink ?? 'null',
      });
    }
    // Frontmatter relations must be a subset of the manifest's — the manifest
    // is the machine-readable index, so a frontmatter-only `supersedes`/`amends`
    // is invisible to every consumer (how a live contradiction hid pre-2026-08).
    // The reverse direction stays legal: legacy entries carry manifest-only links.
    for (const field of ['supersedes', 'amends']) {
      const fmKeys = relationKeys(fm[field]);
      if (fmKeys.length === 0) continue;
      const manifestKeys = new Set(relationKeys(entry[field]));
      for (const target of fmKeys) {
        if (!manifestKeys.has(target)) {
          frontmatterDrift.push({ key, field, file: target, manifest: 'absent' });
        }
      }
    }
  }

  const missingFiles = entries.filter((d) => !fileKeys.has(keyOf(d)));

  const linkIssues = [];
  const linkTargets = (entry, field) => {
    const raw = entry[field];
    return (Array.isArray(raw) ? raw : [raw]).map(normalizeKey).filter(Boolean);
  };
  for (const entry of entries) {
    const key = keyOf(entry);
    if (entry.status === 'superseded' && !normalizeKey(entry.supersededBy)) {
      linkIssues.push({ key, kind: 'superseded-without-link' });
    }
    for (const field of ['supersededBy', 'supersedes', 'amends']) {
      for (const target of linkTargets(entry, field)) {
        if (!byKey.has(target)) {
          linkIssues.push({ key, kind: 'dangling', field, target });
          continue;
        }
        const targetStatus = byKey.get(target).status;
        // `supersedes` asserts full replacement; a live target means this should
        // be an `amends` link (partial) or the target's status was never flipped.
        if (field === 'supersedes' && targetStatus !== 'superseded') {
          linkIssues.push({ key, kind: 'supersedes-live-target', target, targetStatus });
        }
        // Amending a dead document is meaningless; the amender should point at
        // whatever superseded it instead.
        if (field === 'amends' && ['superseded', 'deprecated', 'rejected'].includes(targetStatus)) {
          linkIssues.push({ key, kind: 'amends-terminal-target', target, targetStatus });
        }
      }
    }
  }

  const cycles = [];
  for (const entry of entries) {
    const start = keyOf(entry);
    const seen = new Set([start]);
    let previous = start;
    let current = normalizeKey(entry.supersededBy);
    while (current && byKey.has(current)) {
      if (seen.has(current)) {
        cycles.push({ key: start, via: previous });
        break;
      }
      seen.add(current);
      previous = current;
      current = normalizeKey(byKey.get(current).supersededBy);
    }
  }

  return {
    orphans,
    slugMismatches,
    duplicates,
    missingFiles,
    linkIssues,
    frontmatterDrift,
    cycles,
  };
}

/** Render findings as the hook-facing report; empty array when clean. */
export function formatReport(findings) {
  const {
    orphans,
    slugMismatches,
    duplicates,
    missingFiles,
    linkIssues,
    frontmatterDrift,
    cycles,
  } = findings;
  const total =
    orphans.length +
    slugMismatches.length +
    duplicates.length +
    missingFiles.length +
    linkIssues.length +
    frontmatterDrift.length +
    cycles.length;
  if (total === 0) return [];

  const lines = [
    `[ADR Drift] ${total} manifest integrity issue(s) in decisions/ — run /adr:review or reconcile manually:`,
  ];
  const cap = (arr) => arr.slice(0, 8);
  for (const d of cap(duplicates))
    lines.push(`  - duplicate id: ${d.file} (id ${d.key} already used by another file)`);
  for (const o of cap(orphans)) lines.push(`  - orphan: ${o.file} (id ${o.key} not in manifest)`);
  for (const s of cap(slugMismatches))
    lines.push(`  - collision: ${s.file} (manifest ${s.key} is "${s.manifestSlug}")`);
  for (const m of cap(missingFiles))
    lines.push(`  - missing file: ${keyOf(m)} ${m.slug} (in manifest, no file)`);
  const linkLine = (l) => {
    if (l.kind === 'superseded-without-link')
      return `  - broken link: ${l.key} is superseded but has no supersededBy`;
    if (l.kind === 'supersedes-live-target')
      return `  - contradiction: ${l.key} supersedes ${l.target}, but ${l.target} is ${l.targetStatus} (partial replacement should use amends)`;
    if (l.kind === 'amends-terminal-target')
      return `  - contradiction: ${l.key} amends ${l.target}, but ${l.target} is ${l.targetStatus}`;
    return `  - dangling link: ${l.key} ${l.field} → ${l.target} (no such ADR)`;
  };
  for (const l of cap(linkIssues)) lines.push(linkLine(l));
  for (const f of cap(frontmatterDrift))
    lines.push(
      `  - frontmatter drift: ${f.key} ${f.field} is "${f.file}" on disk, "${f.manifest}" in manifest`
    );
  for (const c of cap(cycles)) lines.push(`  - supersession cycle: ${c.key} ↔ ${c.via}`);
  if (total > 24) lines.push('  - …(truncated)');
  return lines;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const decisionsDir = join(repoRoot, 'decisions');
  if (existsSync(join(decisionsDir, 'manifest.json'))) {
    let lines;
    try {
      lines = formatReport(findDrift(decisionsDir));
    } catch {
      // Total corruption must not be the one state both integrity tools stay
      // silent about — one line, still exit 0 so the hook never blocks.
      lines = ['[ADR Drift] decisions/manifest.json is unreadable (JSON parse failed)'];
    }
    if (lines.length > 0) console.log(lines.join('\n'));
  }
  process.exit(0);
}
