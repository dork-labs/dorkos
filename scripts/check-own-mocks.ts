/**
 * Hold each package's tests to a ratchet on mocking our own code: the number of
 * `vi.mock(...)` calls that name one of our own modules may only fall.
 *
 * WHY THIS EXISTS. A test that replaces a module we own with a fake checks the
 * fake, not the code. It passes when the real module breaks and breaks when the
 * real module is refactored, so it costs time and catches little. On 2026-11-11
 * 522 of 1,733 client test files did it (257 of them faking the whole
 * `@/layers/shared/model` barrel), and 899 of 2,824 server and package test
 * files. The cleanup plan asks for a lint rule against it (DOR-4190). Turning a
 * rule on as an error would red every one of those files at once, and a warning
 * fails nothing, so this is a ratchet instead: today's build stays green, and
 * the count can only go down. Mock at the edges (network, clock, filesystem, a
 * model, a runtime SDK) and use the real module everywhere else.
 *
 * WHAT COUNTS. A `vi.mock` or `vi.doMock` call whose first argument is a string
 * literal naming our own code: a relative path (`./x`, `../x`), the client's
 * `@/` alias, or a workspace package (`@dorkos/*`, `@dork-labs/*`). Third-party
 * modules (`node:fs`, `chokidar`, an SDK) are edges and never count. Lines that
 * are comments are skipped, so a note that quotes a mock does not move the
 * count. Only test files count (`TEST_FILE`).
 *
 * THE UNIT IS THE PACKAGE (`apps/<name>`, `packages/<name>`, or the top-level
 * folder for anything else), not the file, so two PRs editing different tests in
 * one package do not conflict on the baseline, and moving a mock between files
 * is free.
 *
 * WHAT FAILS (exit 1):
 *   - grew:    a package has more own-module mocks than its baseline;
 *   - new:     a package not in the baseline has any;
 *   - stale:   a package has fewer than its baseline says, or none left while
 *              the baseline still lists it. Run `--update`, which only ever
 *              lowers or removes entries, so the gain cannot be spent later;
 *   - raised:  with `--base <ref>`, an entry is higher than the base's or is
 *              new. The baseline is lowered by `--update`, never raised by hand.
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad `--base`): a
 * gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:own-mocks                      check against the baseline
 *   pnpm check:own-mocks -- --base <ref>      also refuse a raised baseline
 *   pnpm check:own-mocks -- --update          lower and remove entries
 *   pnpm check:own-mocks -- --init            write the baseline from scratch
 *   pnpm check:own-mocks -- --root <dir>      measure another tree (tests)
 *
 * @module scripts/check-own-mocks
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/own-mocks/baseline.json';

/** Test files, wherever they sit. */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$/;

/** A mock call and its first argument, when that argument is a plain string. */
const MOCK_CALL = /\bvi\.(?:mock|doMock)\(\s*(['"`])([^'"`]+)\1/g;

/** A specifier that names our own code rather than a third-party edge. */
const OWN_MODULE = /^(\.{1,2}\/|@\/|@dorkos\/|@dork-labs\/)/;

/** A line that is only a comment, so a quoted mock in prose is not a mock. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/** The baseline file: each package's own-module mock count when last measured. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** Package to own-module mock count, sorted by package. */
  packages: Record<string, number>;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the ratchet was broken. */
  kind: 'grew' | 'new' | 'stale' | 'raised';
  /** The package. */
  pkg: string;
  /** Its count now, when it has one. */
  count?: number;
  /** The number the baseline holds for it. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class OwnMocksError extends Error {}

const COMMENT =
  'The own-module mock ratchet (scripts/check-own-mocks.ts, DOR-4190). Each number is how many vi.mock calls in that package name our own code. It may only fall. Run `pnpm check:own-mocks -- --update` after removing some; never raise a number by hand.';

/**
 * The package a repo-relative path belongs to.
 *
 * @param file - A repo-relative path.
 */
export function packageOf(file: string): string {
  const parts = file.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.length > 1 ? (parts[0] ?? '.') : '.';
}

/**
 * Count the own-module mocks in one file's text.
 *
 * @param text - The file's source.
 */
export function countOwnMocks(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (COMMENT_LINE.test(line)) continue;
    for (const match of line.matchAll(MOCK_CALL)) {
      if (OWN_MODULE.test(match[2] ?? '')) n += 1;
    }
  }
  return n;
}

/**
 * Measure every package's own-module mocks.
 *
 * @param root - The tree to measure.
 * @returns Package to count, for packages with at least one.
 */
export function measure(root: string): Record<string, number> {
  // Untracked files too, so a local run agrees with CI before `git add`.
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((file, i, all) => file && TEST_FILE.test(file) && all.indexOf(file) === i);

  const counts: Record<string, number> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const n = countOwnMocks(text);
    if (n > 0) counts[packageOf(file)] = (counts[packageOf(file)] ?? 0) + n;
  }
  return sortKeys(counts);
}

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's packages.
 */
export function compare(
  counts: Record<string, number>,
  baseline: Record<string, number>
): Finding[] {
  const findings: Finding[] = [];
  for (const [pkg, count] of Object.entries(counts)) {
    const held = baseline[pkg];
    if (held === undefined) findings.push({ kind: 'new', pkg, count });
    else if (count > held) findings.push({ kind: 'grew', pkg, count, baseline: held });
    else if (count < held) findings.push({ kind: 'stale', pkg, count, baseline: held });
  }
  for (const [pkg, held] of Object.entries(baseline)) {
    if (!(pkg in counts)) findings.push({ kind: 'stale', pkg, baseline: held });
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
  for (const [pkg, held] of Object.entries(current)) {
    const before = base[pkg];
    if (before === undefined) findings.push({ kind: 'raised', pkg, count: held });
    else if (held > before) findings.push({ kind: 'raised', pkg, count: held, baseline: before });
  }
  return findings;
}

/**
 * The baseline after `--update`: every entry lowered to its count, entries at
 * zero removed, nothing raised and nothing added.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's packages.
 */
export function lowered(
  counts: Record<string, number>,
  baseline: Record<string, number>
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [pkg, held] of Object.entries(baseline)) {
    const count = counts[pkg];
    if (count !== undefined) next[pkg] = Math.min(held, count);
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
      return `${f.pkg}: ${f.count} vi.mock calls on our own modules (baseline ${f.baseline}). Use the real module, or mock only at an edge (network, clock, filesystem, a model).`;
    case 'new':
      return `${f.pkg}: ${f.count} vi.mock calls on our own modules, and this package had none. Use the real module, or mock only at an edge.`;
    case 'stale':
      return f.count === undefined
        ? `${f.pkg}: no own-module mocks left. Run \`pnpm check:own-mocks -- --update\` to drop it from the baseline.`
        : `${f.pkg}: down to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:own-mocks -- --update\` to lock that in.`;
    case 'raised':
      return f.baseline === undefined
        ? `${f.pkg}: added to the baseline at ${f.count}. The baseline is never added to by hand.`
        : `${f.pkg}: baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
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
    throw new OwnMocksError(`${where} is not valid JSON`);
  }
  const packages = (parsed as Partial<Baseline>)?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new OwnMocksError(`${where} has no packages map`);
  }
  for (const [pkg, n] of Object.entries(packages)) {
    if (!Number.isInteger(n) || (n as number) < 1) {
      throw new OwnMocksError(`${where}: ${pkg} must be a whole number above zero`);
    }
  }
  return packages as Record<string, number>;
}

function writeBaseline(root: string, packages: Record<string, number>): void {
  const body: Baseline = { $comment: COMMENT, packages };
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
    throw new OwnMocksError(`--base ${ref} is not a commit this checkout has`);
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
    console.log(`own-mocks: wrote ${Object.keys(counts).length} package(s), ${total} mock(s)`);
    return 0;
  }

  let baselineText: string;
  try {
    baselineText = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new OwnMocksError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(baselineText, BASELINE_PATH);

  if (flag('--update')) {
    const next = lowered(counts, baseline);
    writeBaseline(root, next);
    console.log(`own-mocks: baseline holds ${Object.keys(next).length} package(s)`);
    // Lowering never excuses growth or a new package; say so rather than hide it.
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
    console.log(`own-mocks: clean. ${total} own-module mock(s), none added.`);
    return 0;
  }
  console.error(`own-mocks: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`own-mocks: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
