#!/usr/bin/env node
/**
 * ADR drift detector.
 *
 * Compares on-disk decision files against `decisions/manifest.json` and reports
 * integrity drift that the manifest-only checks (check-adr-curation.sh,
 * /adr:curate) cannot see. Recognizes both id forms (spec #271):
 *   - legacy `NNNN-<slug>.md` (frozen 4-digit numbers)
 *   - timestamp `YYMMDD-HHMMSS-<slug>.md` (new coordination-free ids)
 *
 * Findings:
 *   - orphan files          id on disk not present in the manifest
 *   - slug mismatches       id in the manifest but the on-disk file has a different slug
 *   - missing files         manifest entry with no matching on-disk file
 *   - duplicate ids         two on-disk files share the same id (the timestamp
 *                           backstop for the vanishingly rare same-second clash)
 *
 * Output: prints a concise report ONLY when drift exists (stays silent when clean,
 * so it is safe to call from a SessionStart hook). Always exits 0.
 *
 * Usage: node .claude/scripts/adr-drift-check.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const decisionsDir = join(repoRoot, 'decisions');
const manifestPath = join(decisionsDir, 'manifest.json');

if (!existsSync(manifestPath)) process.exit(0);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  // A malformed manifest is its own problem; don't crash the hook.
  process.exit(0);
}

const entries = manifest.decisions || [];
/** The entry's identity: its timestamp id, or a legacy number zero-padded to 4. */
const keyOf = (d) => d.id ?? String(d.number).padStart(4, '0');
const byKey = new Map(entries.map((d) => [keyOf(d), d]));

// A file id is either a 4-digit legacy number or a YYMMDD-HHMMSS timestamp.
const FILE_RE = /^(\d{4}|\d{6}-\d{6})-(.+)\.md$/;

const fileKeys = new Set();
const orphans = [];
const slugMismatches = [];
const duplicates = [];

for (const file of readdirSync(decisionsDir)) {
  const match = FILE_RE.exec(file);
  if (!match) continue;
  const key = match[1];
  const slug = match[2];

  if (fileKeys.has(key)) {
    duplicates.push({ file, key });
    continue;
  }
  fileKeys.add(key);

  const entry = byKey.get(key);
  if (!entry) {
    orphans.push({ file, key });
  } else if (entry.slug !== slug) {
    slugMismatches.push({ file, key, manifestSlug: entry.slug });
  }
}

const missingFiles = entries.filter((d) => !fileKeys.has(keyOf(d)));

const total = orphans.length + slugMismatches.length + missingFiles.length + duplicates.length;
if (total === 0) process.exit(0);

const lines = [
  `[ADR Drift] ${total} manifest integrity issue(s) in decisions/ — run /adr:curate (handles orphans) or reconcile manually:`,
];
const cap = (arr) => arr.slice(0, 8);
for (const d of cap(duplicates))
  lines.push(`  - duplicate id: ${d.file} (id ${d.key} already used by another file)`);
for (const o of cap(orphans)) lines.push(`  - orphan: ${o.file} (id ${o.key} not in manifest)`);
for (const s of cap(slugMismatches))
  lines.push(`  - collision: ${s.file} (manifest ${s.key} is "${s.manifestSlug}")`);
for (const m of cap(missingFiles))
  lines.push(`  - missing file: ${keyOf(m)} ${m.slug} (in manifest, no file)`);
if (total > 24) lines.push('  - …(truncated)');

console.log(lines.join('\n'));
process.exit(0);
