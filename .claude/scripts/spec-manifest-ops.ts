#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning

/**
 * spec-manifest-ops.ts — Canonical CRUD operations for specs/manifest.json
 *
 * Usage:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/spec-manifest-ops.ts <command> [args] [options]
 *
 * Commands:
 *   add <slug> <title> [options]    Add a new spec entry
 *   update-status <slug> <status>   Update spec status (progression enforced)
 *   get <slug>                      Print spec entry as JSON
 *   list [options]                  List specs
 *   audit [options]                 Audit manifest vs filesystem
 *   fix [options]                   Auto-fix all audit findings
 *   remove <slug>                   Remove a spec entry (manifest only)
 *   archive <slug>                  Move specs/<slug>/ to specs/archive/ + drop entry
 *
 * Options:
 *   --status=<s>     Filter by status (list) or set status (add)
 *   --archived       List archived specs from specs/archive/ (list)
 *   --project=<p>    Set project group (add)
 *   --created=<d>    Set created date, YYYY-MM-DD (add)
 *   --force          Allow status regression (update-status)
 *   --json           Output as JSON (list, audit)
 *   --dry-run        Show what would change without writing (fix)
 *   --quiet          Suppress non-essential output
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { allocateId } from './id.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpecEntry {
  /** Timestamp id (`YYMMDD-HHMMSS`) for new specs; legacy specs use `number`. */
  id?: string;
  /** Legacy sequential number (frozen). New specs use `id` instead. */
  number?: number;
  slug: string;
  title: string;
  created: string;
  status: string;
  project?: string;
}

interface Manifest {
  version: number;
  /** Legacy counter, no longer written (superseded by timestamp ids, spec #271). */
  nextNumber?: number;
  specs: SpecEntry[];
}

interface AuditFinding {
  type: 'non-canonical' | 'mismatch' | 'orphan' | 'missing-dir';
  slug: string;
  detail: string;
  current?: string;
  expected?: string;
  /** The entry's display identity (timestamp id or zero-padded legacy number). */
  key?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANONICAL_STATUSES = ['ideation', 'specified', 'implemented', 'superseded'] as const;

const STATUS_ORDER: Record<string, number> = {
  ideation: 0,
  specified: 1,
  implemented: 2,
  superseded: 3,
};

const STATUS_NORMALIZE: Record<string, string> = {
  draft: 'ideation',
  specification: 'specified',
  completed: 'implemented',
};

const ARTIFACT_TO_STATUS: Record<number, string> = {
  1: 'ideation',
  2: 'specified',
  3: 'specified',
  4: 'implemented',
  5: 'implemented',
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

const ROOT = findProjectRoot();
const MANIFEST_PATH = join(ROOT, 'specs', 'manifest.json');
const SPECS_DIR = join(ROOT, 'specs');
const ARCHIVE_DIR = join(SPECS_DIR, 'archive');

// Subdirectories of specs/ that are NOT spec dirs and must be skipped by the
// filesystem walk (otherwise audit/fix treat them as orphan specs). `archive`
// holds retired specs (see specs/archive/README.md); `lib` holds shared assets.
const SPEC_DIR_EXCLUDES = new Set(['lib', 'archive']);

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Error: Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

function writeManifest(manifest: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function findEntry(manifest: Manifest, slug: string): SpecEntry | undefined {
  return manifest.specs.find((s: SpecEntry) => s.slug === slug);
}

/**
 * The entry's stable identity for display and sorting: its timestamp `id`, or a
 * legacy numeric `number` zero-padded to 4 digits. Legacy ids sort before
 * timestamp ids under a plain string comparison, so mixed listings stay ordered.
 */
function entryKey(entry: SpecEntry): string {
  return entry.id ?? String(entry.number).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCanonical(status: string): boolean {
  return (CANONICAL_STATUSES as readonly string[]).includes(status);
}

function normalizeStatus(status: string): string {
  if (isCanonical(status)) return status;
  return STATUS_NORMALIZE[status] ?? status;
}

function getHighestArtifact(slug: string): number {
  const dir = join(SPECS_DIR, slug);
  if (!existsSync(dir)) return 0;

  let highest = 0;
  for (const file of readdirSync(dir)) {
    const match = file.match(/^0([1-5])-.*\.(md|json)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > highest) highest = num;
    }
  }
  return highest;
}

function extractTitle(slug: string): string {
  const dir = join(SPECS_DIR, slug);

  // Try 02-specification.md first, then 01-ideation.md
  for (const file of ['02-specification.md', '01-ideation.md']) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf-8');
    // Look for first # heading after frontmatter
    const lines = content.split('\n');
    let pastFrontmatter = false;
    let inFrontmatter = false;

    for (const line of lines) {
      if (line.trim() === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
          continue;
        }
        pastFrontmatter = true;
        continue;
      }
      if (!pastFrontmatter && inFrontmatter) continue;

      const heading = line.match(/^#\s+(.+)/);
      if (heading) return heading[1].trim();
    }
  }

  // Fallback: convert slug to title case
  return slug
    .split('-')
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getSpecDirs(): Set<string> {
  const dirs = new Set<string>();
  if (!existsSync(SPECS_DIR)) return dirs;

  for (const entry of readdirSync(SPECS_DIR)) {
    const fullPath = join(SPECS_DIR, entry);
    if (
      statSync(fullPath).isDirectory() &&
      !entry.startsWith('__') &&
      !SPEC_DIR_EXCLUDES.has(entry)
    ) {
      dirs.add(entry);
    }
  }
  return dirs;
}

/**
 * List archived spec slugs (directories under specs/archive/). Archived specs
 * are moved out of the manifest, so they are discovered from disk rather than
 * the manifest. Excludes README.md and other non-directory entries.
 */
function getArchivedSlugs(): string[] {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter((entry) => {
      const fullPath = join(ARCHIVE_DIR, entry);
      return statSync(fullPath).isDirectory() && !entry.startsWith('__');
    })
    .sort();
}

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: command ?? 'help', positional, flags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdAdd(positional: string[], flags: Record<string, string | boolean>): void {
  const slug = positional[0];
  const title = positional.slice(1).join(' ') || extractTitle(slug);

  if (!slug) {
    console.error(
      'Usage: add <slug> [title] [--status=ideation] [--project=X] [--created=YYYY-MM-DD]'
    );
    process.exit(1);
  }

  const manifest = readManifest();

  if (findEntry(manifest, slug)) {
    console.error(`Error: Spec "${slug}" already exists in manifest`);
    process.exit(1);
  }

  const status = normalizeStatus(String(flags.status ?? 'ideation'));
  if (!isCanonical(status)) {
    console.error(
      `Error: Invalid status "${flags.status}". Valid: ${CANONICAL_STATUSES.join(', ')}`
    );
    process.exit(1);
  }

  const taken = new Set(manifest.specs.map(entryKey));
  const entry: SpecEntry = {
    id: allocateId((id) => taken.has(id)),
    slug,
    title: title || slug,
    created: String(flags.created ?? today()),
    status,
  };

  if (flags.project) {
    entry.project = String(flags.project);
  }

  manifest.specs.unshift(entry);
  writeManifest(manifest);

  if (!flags.quiet) {
    console.log(`Added spec ${entry.id}: ${slug} (${status})`);
  }
}

function cmdUpdateStatus(positional: string[], flags: Record<string, string | boolean>): void {
  const [slug, rawStatus] = positional;

  if (!slug || !rawStatus) {
    console.error('Usage: update-status <slug> <status> [--force]');
    process.exit(1);
  }

  const status = normalizeStatus(rawStatus);
  if (!isCanonical(status)) {
    console.error(`Error: Invalid status "${rawStatus}". Valid: ${CANONICAL_STATUSES.join(', ')}`);
    process.exit(1);
  }

  const manifest = readManifest();
  const entry = findEntry(manifest, slug);

  if (!entry) {
    console.error(`Error: Spec "${slug}" not found in manifest`);
    process.exit(1);
  }

  const currentOrder = STATUS_ORDER[normalizeStatus(entry.status)] ?? -1;
  const newOrder = STATUS_ORDER[status] ?? -1;

  if (newOrder < currentOrder && !flags.force) {
    console.error(
      `Error: Cannot regress "${slug}" from "${entry.status}" to "${status}". Use --force to override.`
    );
    process.exit(1);
  }

  if (entry.status === status) {
    if (!flags.quiet) {
      console.log(`No change: "${slug}" is already "${status}"`);
    }
    return;
  }

  const old = entry.status;
  entry.status = status;
  writeManifest(manifest);

  if (!flags.quiet) {
    console.log(`Updated "${slug}": ${old} → ${status}`);
  }
}

function cmdGet(positional: string[]): void {
  const slug = positional[0];
  if (!slug) {
    console.error('Usage: get <slug>');
    process.exit(1);
  }

  const manifest = readManifest();
  const entry = findEntry(manifest, slug);

  if (!entry) {
    console.error(`Error: Spec "${slug}" not found`);
    process.exit(1);
  }

  console.log(JSON.stringify(entry, null, 2));
}

function cmdList(flags: Record<string, string | boolean>): void {
  if (flags.archived) {
    const slugs = getArchivedSlugs();
    if (flags.json) {
      console.log(JSON.stringify(slugs, null, 2));
      return;
    }
    if (slugs.length === 0) {
      console.log('No archived specs found.');
      return;
    }
    console.log('Archived specs (in specs/archive/, not in the manifest):\n');
    for (const slug of slugs) {
      console.log(`  ${slug}`);
    }
    console.log(`\nTotal: ${slugs.length} archived spec(s)`);
    return;
  }

  const manifest = readManifest();
  let specs = manifest.specs;

  if (flags.status) {
    const filterStatus = normalizeStatus(String(flags.status));
    specs = specs.filter((s: SpecEntry) => normalizeStatus(s.status) === filterStatus);
  }

  if (flags.json) {
    console.log(JSON.stringify(specs, null, 2));
    return;
  }

  if (specs.length === 0) {
    console.log('No specs found.');
    return;
  }

  // Table output
  console.log(`${'ID'.padEnd(13)}  ${'Status'.padEnd(13)} ${'Slug'.padEnd(50)} Title`);
  console.log('─'.repeat(100));
  for (const s of specs) {
    const statusDisplay = isCanonical(s.status) ? s.status : `${s.status} (!!)`;
    console.log(
      `${entryKey(s).padEnd(13)}  ${statusDisplay.padEnd(13)} ${s.slug.padEnd(50)} ${s.title}`
    );
  }
  console.log(`\nTotal: ${specs.length} specs`);
}

function cmdAudit(flags: Record<string, string | boolean>): AuditFinding[] {
  const manifest = readManifest();
  const specDirs = getSpecDirs();
  const manifestSlugs = new Set(manifest.specs.map((s: SpecEntry) => s.slug));
  const findings: AuditFinding[] = [];

  // 1. Check for non-canonical statuses
  for (const entry of manifest.specs) {
    if (!isCanonical(entry.status)) {
      const normalized = normalizeStatus(entry.status);
      findings.push({
        type: 'non-canonical',
        slug: entry.slug,
        key: entryKey(entry),
        detail: `Status "${entry.status}" is not canonical`,
        current: entry.status,
        expected: isCanonical(normalized) ? normalized : 'ideation',
      });
    }
  }

  // 2. Check for status mismatches (manifest vs artifacts)
  for (const entry of manifest.specs) {
    if (!specDirs.has(entry.slug)) continue;
    if (entry.status === 'superseded') continue; // Don't override superseded

    const highest = getHighestArtifact(entry.slug);
    if (highest === 0) continue;

    const expectedStatus = ARTIFACT_TO_STATUS[highest];
    if (!expectedStatus) continue;

    const currentNormalized = normalizeStatus(entry.status);
    const currentOrder = STATUS_ORDER[currentNormalized] ?? -1;
    const expectedOrder = STATUS_ORDER[expectedStatus] ?? -1;

    if (expectedOrder > currentOrder) {
      findings.push({
        type: 'mismatch',
        slug: entry.slug,
        key: entryKey(entry),
        detail: `Highest artifact is 0${highest}, but status is "${entry.status}"`,
        current: entry.status,
        expected: expectedStatus,
      });
    }
  }

  // 3. Check for orphan directories (in filesystem but not manifest)
  for (const dir of specDirs) {
    if (!manifestSlugs.has(dir)) {
      const highest = getHighestArtifact(dir);
      const status = ARTIFACT_TO_STATUS[highest] ?? 'ideation';
      findings.push({
        type: 'orphan',
        slug: dir,
        detail: `Directory exists with ${highest} artifact(s) but no manifest entry`,
        expected: status,
      });
    }
  }

  // 4. Check for manifest entries with no directory
  for (const entry of manifest.specs) {
    if (!specDirs.has(entry.slug)) {
      findings.push({
        type: 'missing-dir',
        slug: entry.slug,
        key: entryKey(entry),
        detail: `Manifest entry exists but no specs/${entry.slug}/ directory`,
        current: entry.status,
      });
    }
  }

  // Output
  if (flags.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    printAuditReport(findings);
  }

  return findings;
}

function printAuditReport(findings: AuditFinding[]): void {
  const byType = (type: AuditFinding['type']) =>
    findings.filter((f: AuditFinding) => f.type === type);

  const nonCanonical = byType('non-canonical');
  const mismatches = byType('mismatch');
  const orphans = byType('orphan');
  const missingDirs = byType('missing-dir');

  console.log('SPEC MANIFEST AUDIT');
  console.log('═'.repeat(60));

  if (nonCanonical.length > 0) {
    console.log(`\nNon-canonical statuses: ${nonCanonical.length}`);
    for (const f of nonCanonical) {
      console.log(`  ${f.key} ${f.slug}: ${f.current} → ${f.expected}`);
    }
  }

  if (mismatches.length > 0) {
    console.log(`\nStatus mismatches: ${mismatches.length}`);
    for (const f of mismatches) {
      console.log(`  ${f.key} ${f.slug}: manifest=${f.current}, artifacts=${f.expected}`);
    }
  }

  if (orphans.length > 0) {
    console.log(`\nOrphan directories: ${orphans.length}`);
    for (const f of orphans) {
      console.log(`  ${f.slug}/ → would be added as "${f.expected}"`);
    }
  }

  if (missingDirs.length > 0) {
    console.log(`\nManifest entries with no directory: ${missingDirs.length}`);
    for (const f of missingDirs) {
      console.log(`  ${f.key} ${f.slug} (${f.current})`);
    }
  }

  const total = findings.length;
  console.log(`\n${'═'.repeat(60)}`);
  if (total === 0) {
    console.log('All clear — manifest is in sync with filesystem.');
  } else {
    console.log(`Total issues: ${total}`);
    console.log('Run with "fix" command to auto-resolve.');
  }
}

function cmdFix(flags: Record<string, string | boolean>): void {
  const dryRun = !!flags['dry-run'];
  const manifest = readManifest();
  const specDirs = getSpecDirs();
  const manifestSlugs = new Set(manifest.specs.map((s: SpecEntry) => s.slug));

  let normalized = 0;
  let statusFixed = 0;
  let orphansAdded = 0;

  // 1. Normalize non-canonical statuses
  for (const entry of manifest.specs) {
    if (!isCanonical(entry.status)) {
      const newStatus = normalizeStatus(entry.status);
      const final = isCanonical(newStatus) ? newStatus : 'ideation';
      if (!dryRun) entry.status = final;
      console.log(`  Normalize: ${entryKey(entry)} ${entry.slug}: ${entry.status} → ${final}`);
      normalized++;
    }
  }

  // 2. Fix status mismatches
  for (const entry of manifest.specs) {
    if (!specDirs.has(entry.slug)) continue;
    if (entry.status === 'superseded') continue;

    const highest = getHighestArtifact(entry.slug);
    if (highest === 0) continue;

    const expectedStatus = ARTIFACT_TO_STATUS[highest];
    if (!expectedStatus) continue;

    const currentNormalized = normalizeStatus(entry.status);
    const currentOrder = STATUS_ORDER[currentNormalized] ?? -1;
    const expectedOrder = STATUS_ORDER[expectedStatus] ?? -1;

    if (expectedOrder > currentOrder) {
      const oldStatus = entry.status;
      if (!dryRun) entry.status = expectedStatus;
      console.log(
        `  Status fix: ${entryKey(entry)} ${entry.slug}: ${oldStatus} → ${expectedStatus}`
      );
      statusFixed++;
    }
  }

  // 3. Add orphan directories
  const orphanSlugs = [...specDirs].filter((d: string) => !manifestSlugs.has(d)).sort();
  const takenIds = new Set(manifest.specs.map(entryKey));
  for (const slug of orphanSlugs) {
    const highest = getHighestArtifact(slug);
    const status = ARTIFACT_TO_STATUS[highest] ?? 'ideation';
    const title = extractTitle(slug);

    const id = allocateId((candidate) => takenIds.has(candidate));
    takenIds.add(id);
    const entry: SpecEntry = {
      id,
      slug,
      title,
      created: today(),
      status,
    };

    if (!dryRun) {
      manifest.specs.push(entry);
    }

    console.log(`  Add orphan: ${id} ${slug} (${status}): "${title}"`);
    orphansAdded++;
  }

  // Sort manifest: newest first (by id/number key, descending). Legacy numeric
  // keys sort before timestamp keys, so this keeps frozen specs after new ones.
  if (!dryRun) {
    manifest.specs.sort((a: SpecEntry, b: SpecEntry) => entryKey(b).localeCompare(entryKey(a)));
    writeManifest(manifest);
  }

  // Summary
  const total = normalized + statusFixed + orphansAdded;
  console.log(`\n${dryRun ? 'DRY RUN — ' : ''}Fix summary:`);
  console.log(`  Normalized statuses: ${normalized}`);
  console.log(`  Status mismatches fixed: ${statusFixed}`);
  console.log(`  Orphan directories added: ${orphansAdded}`);
  console.log(`  Total changes: ${total}`);

  if (dryRun && total > 0) {
    console.log('\nRe-run without --dry-run to apply changes.');
  }
}

function cmdRemove(positional: string[], flags: Record<string, string | boolean>): void {
  const slug = positional[0];
  if (!slug) {
    console.error('Usage: remove <slug>');
    process.exit(1);
  }

  const manifest = readManifest();
  const idx = manifest.specs.findIndex((s: SpecEntry) => s.slug === slug);

  if (idx === -1) {
    console.error(`Error: Spec "${slug}" not found in manifest`);
    process.exit(1);
  }

  const removed = manifest.specs.splice(idx, 1)[0];
  writeManifest(manifest);

  if (!flags.quiet) {
    console.log(`Removed spec ${entryKey(removed)}: ${slug}`);
  }
}

/**
 * Retire a spec: move its directory to `specs/archive/<slug>/` and drop its
 * manifest entry. Mirrors the decisions/archive lifecycle (move the file,
 * remove the manifest entry). See specs/archive/README.md for the policy and
 * the trigger guideline. Timestamp ids (and frozen legacy numbers) are never
 * reused, so dropping an entry is always safe.
 */
function cmdArchive(positional: string[], flags: Record<string, string | boolean>): void {
  const slug = positional[0];
  if (!slug) {
    console.error('Usage: archive <slug>');
    process.exit(1);
  }

  const manifest = readManifest();
  const idx = manifest.specs.findIndex((s: SpecEntry) => s.slug === slug);
  const entry = idx === -1 ? undefined : manifest.specs[idx];

  const srcDir = join(SPECS_DIR, slug);
  const destDir = join(ARCHIVE_DIR, slug);

  if (!entry && !existsSync(srcDir)) {
    console.error(`Error: Spec "${slug}" has no manifest entry and no specs/${slug}/ directory`);
    process.exit(1);
  }

  if (existsSync(destDir)) {
    console.error(`Error: specs/archive/${slug}/ already exists: refusing to overwrite`);
    process.exit(1);
  }

  // Move the directory (if it exists on disk) into specs/archive/.
  if (existsSync(srcDir)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    renameSync(srcDir, destDir);
  }

  // Drop the manifest entry (archived specs leave the manifest entirely).
  if (idx !== -1) {
    manifest.specs.splice(idx, 1);
    writeManifest(manifest);
  }

  if (!flags.quiet) {
    const numLabel = entry ? `${entryKey(entry)} ` : '';
    const moved = existsSync(destDir) ? ` → specs/archive/${slug}/` : '';
    console.log(`Archived spec ${numLabel}${slug}${moved} (removed from manifest)`);
  }
}

function cmdHelp(): void {
  console.log(`spec-manifest-ops — Canonical CRUD for specs/manifest.json

Commands:
  add <slug> [title]              Add a new spec entry
    --status=<s>                  Status (default: ideation)
    --project=<p>                 Project group
    --created=<d>                 Created date (default: today)

  update-status <slug> <status>   Update spec status
    --force                       Allow status regression
    --quiet                       Suppress output

  get <slug>                      Print spec entry as JSON

  list                            List all specs
    --status=<s>                  Filter by status
    --archived                    List archived specs (in specs/archive/, not the manifest)
    --json                        Output as JSON

  audit                           Audit manifest vs filesystem
    --json                        Output findings as JSON

  fix                             Auto-fix all audit findings
    --dry-run                     Show what would change

  remove <slug>                   Remove a spec entry (manifest only)

  archive <slug>                  Retire a spec: move specs/<slug>/ to
                                  specs/archive/<slug>/ and drop the manifest
                                  entry (see specs/archive/README.md)

Canonical statuses: ${CANONICAL_STATUSES.join(', ')}
Status progression: ideation → specified → implemented → superseded`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { command, positional, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'add':
    cmdAdd(positional, flags);
    break;
  case 'update-status':
    cmdUpdateStatus(positional, flags);
    break;
  case 'get':
    cmdGet(positional);
    break;
  case 'list':
    cmdList(flags);
    break;
  case 'audit':
    cmdAudit(flags);
    break;
  case 'fix':
    cmdFix(flags);
    break;
  case 'remove':
    cmdRemove(positional, flags);
    break;
  case 'archive':
    cmdArchive(positional, flags);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
