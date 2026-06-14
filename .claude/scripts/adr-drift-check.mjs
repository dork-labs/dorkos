#!/usr/bin/env node
/**
 * ADR drift detector.
 *
 * Compares on-disk `decisions/NNNN-*.md` files against `decisions/manifest.json`
 * and reports integrity drift that the manifest-only checks (check-adr-curation.sh,
 * /adr:curate) cannot see:
 *
 *   - orphan files          number on disk not present in the manifest
 *   - slug mismatches       number in manifest but the on-disk file has a different slug
 *   - missing files         manifest entry with no matching on-disk file
 *
 * This closes the gap that let auto-extracted/`/adr:from-spec` drafts accumulate
 * as orphans (see decisions/archive/ cleanup, 2026-06-13).
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
const byNumber = new Map(entries.map((d) => [d.number, d]));

const fileNumbers = new Set();
const orphans = [];
const slugMismatches = [];

for (const file of readdirSync(decisionsDir)) {
  const match = /^(\d{4})-(.+)\.md$/.exec(file);
  if (!match) continue;
  const number = parseInt(match[1], 10);
  const slug = match[2];
  fileNumbers.add(number);

  const entry = byNumber.get(number);
  if (!entry) {
    orphans.push({ file, number });
  } else if (entry.slug !== slug) {
    slugMismatches.push({ file, number, manifestSlug: entry.slug });
  }
}

const missingFiles = entries.filter((d) => !fileNumbers.has(d.number));

const total = orphans.length + slugMismatches.length + missingFiles.length;
if (total === 0) process.exit(0);

const lines = [
  `[ADR Drift] ${total} manifest integrity issue(s) in decisions/ — run /adr:curate (handles orphans) or reconcile manually:`,
];
const cap = (arr) => arr.slice(0, 8);
for (const o of cap(orphans))
  lines.push(`  - orphan: ${o.file} (number ${o.number} not in manifest)`);
for (const s of cap(slugMismatches))
  lines.push(`  - collision: ${s.file} (manifest #${s.number} is "${s.manifestSlug}")`);
for (const m of cap(missingFiles))
  lines.push(`  - missing file: #${m.number} ${m.slug} (in manifest, no file)`);
if (orphans.length + slugMismatches.length + missingFiles.length > 24)
  lines.push('  - …(truncated)');

console.log(lines.join('\n'));
process.exit(0);
