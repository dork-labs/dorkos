/**
 * Hold the turn port's ratchet baseline to its own rules (spec
 * `turns-survive-restarts` §3.4, DOR-5157): the imports of turn code a
 * space-side file still holds may only go, and the numbers in
 * `apps/server/eslint-rules/turn-port-boundary.baseline.json` may only fall.
 *
 * --help
 * Purpose: hold the turn port's baseline to its rules: space-side imports of
 *          turn code may only go, and entries only fall.
 * Runs in: `pnpm ratchet` (pre-push; the required `typecheck` job).
 * To fix:  remove the import it names. After removing some, run
 *          `pnpm check:turn-port -- --update`. Never raise or add an entry.
 * Usage:   pnpm check:turn-port [-- --base <ref> | --update | --init | --root <dir>]
 * --help end
 *
 * WHY THIS EXISTS. The ESLint rule (`apps/server/eslint-rules/turn-port-boundary.js`)
 * refuses, file by file, an import past its entry and a drop its entry has
 * not locked in. It cannot see two things: a baseline raised by hand (the
 * rule would read the raised number and pass), and an entry for a file that
 * no longer exists (no file, nothing to lint). This script measures the same
 * thing the rule does, with the rule's own classifier, and checks both.
 *
 * WHAT COUNTS. Every import, export-from and literal `import()` in a
 * non-test file of one of the fourteen space-side domains whose specifier
 * resolves into turn code, type-only imports included. The specifiers are read
 * by TypeScript's own pre-processor, never matched as text, and classified by
 * `crossing()` from the rule, so the two can never disagree about a path; a
 * count that differs from the rule's shows as a lint error on that file.
 *
 * WHAT FAILS (exit 1):
 *   - grew:    a file holds more imports of turn code than its entry;
 *   - new:     a file with no entry holds any;
 *   - stale:   a file holds fewer than its entry, or none left (or is gone)
 *              while the baseline still lists it. Run `--update`, which only
 *              lowers or removes entries, so the gain cannot be spent later;
 *   - raised:  with `--base <ref>`, an entry is higher than the base's or is
 *              new. The baseline is lowered by `--update`, never raised by hand.
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad `--base`): a
 * gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:turn-port                      check against the baseline
 *   pnpm check:turn-port -- --base <ref>      also refuse a raised baseline
 *   pnpm check:turn-port -- --update          lower and remove entries
 *   pnpm check:turn-port -- --init            write the baseline from scratch
 *   pnpm check:turn-port -- --root <dir>      measure another tree (tests)
 *
 * @module scripts/turn-port/check-turn-port-boundary
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { crossing, sideOf } from '../../apps/server/eslint-rules/turn-port-boundary.js';
import { exitOnHelp } from '../lib/gate-help.mjs';

/** The server package, relative to the root. */
const SERVER = 'apps/server';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = `${SERVER}/eslint-rules/turn-port-boundary.baseline.json`;

/** Test files, which the rule does not check. */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$/u;

/** The baseline file: each file's imports of turn code when last measured. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** File, relative to the server package, to its count; sorted by path. */
  files: Record<string, number>;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the ratchet was broken. */
  kind: 'grew' | 'new' | 'stale' | 'raised';
  /** The file, relative to the server package. */
  file: string;
  /** Its count now, when it has one. */
  count?: number;
  /** The number the baseline holds for it. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class TurnPortRatchetError extends Error {}

const COMMENT =
  "The turn port's ratchet (apps/server/eslint-rules/turn-port-boundary.js, spec turns-survive-restarts §3.4, DOR-5157). Each number is how many imports of turn code that space-side file still holds. It may only fall. Run `pnpm check:turn-port -- --update` after removing some; never raise a number by hand.";

/**
 * Count one file's imports of turn code.
 *
 * @param absolutePath - The file, absolute, so its specifiers resolve against it.
 * @param text - Its source.
 */
export function countCrossings(absolutePath: string, text: string): number {
  const { importedFiles } = ts.preProcessFile(text, true, true);
  return importedFiles.filter((ref) => crossing(absolutePath, ref.fileName) === 'space').length;
}

/**
 * Measure every space-side file's imports of turn code.
 *
 * @param root - The tree to measure.
 * @returns File (relative to the server package) to count, for files with at least one.
 */
export function measure(root: string): Record<string, number> {
  // Untracked files too, so a local run agrees with CI before `git add`.
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      `${SERVER}/src/services/*.ts`,
      `${SERVER}/src/services/*.tsx`,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((file, i, all) => file && !TEST_FILE.test(file) && all.indexOf(file) === i);

  const counts: Record<string, number> = {};
  for (const file of files) {
    const absolute = resolve(root, file);
    if (sideOf(absolute) !== 'space') continue;
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const n = countCrossings(absolute, text);
    if (n > 0) counts[file.slice(SERVER.length + 1)] = n;
  }
  return sortKeys(counts);
}

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's files.
 */
export function compare(
  counts: Record<string, number>,
  baseline: Record<string, number>
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, count] of Object.entries(counts)) {
    const held = baseline[file];
    if (held === undefined) findings.push({ kind: 'new', file, count });
    else if (count > held) findings.push({ kind: 'grew', file, count, baseline: held });
    else if (count < held) findings.push({ kind: 'stale', file, count, baseline: held });
  }
  for (const [file, held] of Object.entries(baseline)) {
    if (!(file in counts)) findings.push({ kind: 'stale', file, baseline: held });
  }
  return findings;
}

/**
 * Entries the baseline raised against its base: higher than before, or new.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(
  current: Record<string, number>,
  base: Record<string, number>
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, held] of Object.entries(current)) {
    const before = base[file];
    if (before === undefined) findings.push({ kind: 'raised', file, count: held });
    else if (held > before) findings.push({ kind: 'raised', file, count: held, baseline: before });
  }
  return findings;
}

/**
 * The baseline after `--update`: every entry lowered to its count, entries at
 * zero removed, nothing raised and nothing added.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's files.
 */
export function lowered(
  counts: Record<string, number>,
  baseline: Record<string, number>
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [file, held] of Object.entries(baseline)) {
    const count = counts[file];
    if (count !== undefined) next[file] = Math.min(held, count);
  }
  return sortKeys(next);
}

/**
 * One line a person can act on.
 *
 * @param f - The finding.
 */
export function describe(f: Finding): string {
  switch (f.kind) {
    case 'grew':
      return `${f.file}: ${f.count} imports of turn code (baseline ${f.baseline}). Start, watch and stop turns through services/runs; move a shared type to packages/shared.`;
    case 'new':
      return `${f.file}: ${f.count} imports of turn code, and this file had none. Go through services/runs instead.`;
    case 'stale':
      return f.count === undefined
        ? `${f.file}: no imports of turn code left. Run \`pnpm check:turn-port -- --update\` to drop it from the baseline.`
        : `${f.file}: down to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:turn-port -- --update\` to lock that in.`;
    case 'raised':
      return f.baseline === undefined
        ? `${f.file}: added to the baseline at ${f.count}. The baseline is never added to by hand.`
        : `${f.file}: baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
  }
}

function sortKeys(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(text: string, where: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TurnPortRatchetError(`${where} is not valid JSON`);
  }
  const files = (parsed as Partial<Baseline>)?.files;
  if (!files || typeof files !== 'object') {
    throw new TurnPortRatchetError(`${where} has no files map`);
  }
  for (const [file, n] of Object.entries(files)) {
    if (!Number.isInteger(n) || (n as number) < 1) {
      throw new TurnPortRatchetError(`${where}: ${file} must be a whole number above zero`);
    }
  }
  return files as Record<string, number>;
}

function writeBaseline(root: string, files: Record<string, number>): void {
  const body: Baseline = { $comment: COMMENT, files };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The baseline as it was at `ref`, or `null` when that tree had none. A ref
 * git cannot resolve is a failure to measure, never a skipped check.
 */
function baselineAt(root: string, ref: string): Record<string, number> | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new TurnPortRatchetError(`--base ${ref} is not a commit this checkout has`);
  }
  let text: string;
  try {
    text = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  return readBaseline(text, `${BASELINE_PATH} at ${ref}`);
}

function main(argv: string[]): number {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = resolve(value('--root') ?? process.cwd());
  const counts = measure(root);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (flag('--init')) {
    writeBaseline(root, counts);
    console.log(`turn-port: wrote ${Object.keys(counts).length} file(s), ${total} import(s)`);
    return 0;
  }

  let baselineText: string;
  try {
    baselineText = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new TurnPortRatchetError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(baselineText, BASELINE_PATH);

  if (flag('--update')) {
    const next = lowered(counts, baseline);
    writeBaseline(root, next);
    console.log(`turn-port: baseline holds ${Object.keys(next).length} file(s)`);
    // Lowering never excuses growth or a new file; say so rather than hide it.
    const left = compare(counts, next).filter((f) => f.kind !== 'stale');
    for (const f of left) console.error(`  ${describe(f)}`);
    return left.length ? 1 : 0;
  }

  const findings = compare(counts, baseline);
  const base = value('--base');
  if (base) {
    const before = baselineAt(root, base);
    if (before) findings.push(...raisedAgainst(baseline, before));
  }

  if (findings.length === 0) {
    console.log(`turn-port: clean. ${total} import(s) of turn code left, none added.`);
    return 0;
  }
  console.error(`turn-port: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(import.meta.url);
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`turn-port: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
