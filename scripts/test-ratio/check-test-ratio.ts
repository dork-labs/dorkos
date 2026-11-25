/**
 * Hold each package's test code to a budget: it may not add lines of test
 * faster than it adds lines of source, and the budget only tightens.
 *
 * WHY THIS EXISTS. Agents write tests faster than anyone reads them. On
 * 2026-11-23 the repo held more lines of test than of source, and every one of
 * those lines is read, run, edited and waited on. Nothing pushed the other way:
 * the pass-count ratchets in `ci/ratchets.yaml` only stop a count falling. This
 * is the budget. Past it, a PR pays for new tests by deleting weaker ones
 * (`.claude/rules/testing.md`, "Is this test worth keeping?"). The weekly prune
 * (`pruning-tests` skill) deletes low-value tests and runs `--update` to lower
 * the ceilings, so the budget tightens over time.
 *
 * WHAT COUNTS. Non-blank lines in tracked and untracked `.ts`/`.tsx` files.
 * A test file is one under `__tests__/` or named `*.test.*`/`*.spec.*`
 * (`TEST_FILE`, the same shape `check-own-mocks.ts` uses); everything else is
 * source, except declaration files and generated files (`SKIPPED_FILE`).
 *
 * THE UNIT IS THE PACKAGE (`apps/<name>`, `packages/<name>`, or the top-level
 * folder for anything else). A package with fewer than `MIN_SOURCE_LINES` lines
 * of source is not measured: its ratio swings too far on one file to mean
 * anything. Nor is a test-tier package (`TEST_TIER_PACKAGES`), whose specs test
 * code in another package; the keep-rubric and the weekly prune still apply.
 *
 * A CEILING HAS TWO PARTS, and a package passes while it is under EITHER: a
 * ratio (test lines per source line) and a count of test lines. The ratio lets
 * tests grow with new source. The count means deleting source (dead code, a
 * removed feature) never fails a package that added no tests. A package fails
 * only when it holds more test lines than its count AND more per line of
 * source than its ratio: it added tests faster than source.
 *
 * WHY A CEILING AND NOT AN EXACT NUMBER. Failing every PR whose numbers moved
 * until someone ran `--update` (as the own-mocks ratchet does) would make the
 * baseline conflict in nearly every PR. Ceilings move only when lowered: after
 * a prune, or in the weekly run. Each is set `HEADROOM_LINES` of test above
 * today (the ratio rounded up to two decimals, never below `MIN_CEILING`), so a
 * package can take a few small PRs of tests before it has to prune.
 *
 * WHAT FAILS (exit 1):
 *   - over:    a package is past both parts of its ceiling;
 *   - new:     a measured package not in the baseline has more test than
 *              source (`NEW_PACKAGE_CEILING`);
 *   - raised:  with `--base <ref>`, a part of a ceiling is higher than the
 *              base's, or a new entry is looser than `--update` would write;
 *   - dropped: with `--base <ref>`, a ceiling the base had is gone while its
 *              package is still measured. Ceilings are lowered by `--update`,
 *              never raised or removed by hand.
 *
 * `--base` runs at pre-push; the required `typecheck` check runs only "the
 * repo" test, so a baseline edit pushed past the hook is caught by review.
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad `--base`): a
 * gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:test-ratio                      check against the baseline
 *   pnpm check:test-ratio -- --base <ref>      also refuse a loosened ceiling
 *   pnpm check:test-ratio -- --update          lower every ceiling, add new packages
 *   pnpm check:test-ratio -- --update --package <pkg>   lower (or add) one only
 *   pnpm check:test-ratio -- --report          print every package's numbers
 *   pnpm check:test-ratio -- --init            write the baseline from scratch
 *   pnpm check:test-ratio -- --root <dir>      measure another tree (tests)
 *
 * @module scripts/test-ratio/check-test-ratio
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/test-ratio/baseline.json';

/** Below this many source lines a package is not measured. */
export const MIN_SOURCE_LINES = 1000;

/** The ratio a newly measured package starts under: no more test than source. */
export const NEW_PACKAGE_CEILING = 1;

/**
 * No ratio ceiling goes below this. Half a line of test per line of source is
 * not bloat, and a package with few tests must still be able to add the one it
 * needs.
 */
export const MIN_CEILING = 0.5;

/** Lines of test a ceiling leaves room for above today's count. */
export const HEADROOM_LINES = 300;

/**
 * Packages that hold tests of other packages' code: the browser suite and the
 * space server's test tiers (its code lives in `apps/server`).
 */
export const TEST_TIER_PACKAGES = new Set(['apps/e2e', 'apps/space']);

/** Test files, wherever they sit. */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$/;

/** Declaration and generated files: neither source anyone writes nor tests. */
const SKIPPED_FILE = /\.d\.ts$|\.gen\.tsx?$|(^|\/)generated\//;

/** One package's line counts. */
export interface Lines {
  /** Non-blank lines of source. */
  source: number;
  /** Non-blank lines of test. */
  test: number;
}

/** One package's ceiling: it passes while under either part. */
export interface Ceiling {
  /** Lines of test per line of source, two decimals. */
  ratio: number;
  /** Lines of test. */
  tests: number;
}

/** The baseline file: each package's ceiling. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** Package to ceiling, sorted by package. */
  packages: Record<string, Ceiling>;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule was broken. */
  kind: 'over' | 'new' | 'raised' | 'dropped';
  /** The package. */
  pkg: string;
  /** Its counts now, for `over` and `new`. */
  lines?: Lines;
  /** The ceiling it was held to, or the base's for `raised` and `dropped`. */
  ceiling?: Ceiling;
  /** The loosened ceiling, for `raised`. */
  loosened?: Ceiling;
}

/** A thrown failure that means "could not measure", exit 2. */
export class TestRatioError extends Error {}

const COMMENT =
  'The test budget (scripts/test-ratio/check-test-ratio.ts). Each package passes while under either its ratio (lines of test per line of source) or its count of test lines. Both only fall. Run `pnpm check:test-ratio -- --update --package <pkg>` after deleting tests; never raise or remove an entry by hand.';

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
 * Whether a repo-relative path is a test file.
 *
 * @param file - A repo-relative path.
 */
export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/**
 * Non-blank lines in a file's text.
 *
 * @param text - The file's contents.
 */
export function countLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n += 1;
  return n;
}

/**
 * A ratio rounded up to two decimals, the precision ceilings are kept at.
 *
 * @param lines - One package's counts; `source` must be above zero.
 */
export function ratioOf(lines: Lines): number {
  return Math.ceil((lines.test / lines.source) * 100 - 1e-9) / 100;
}

/**
 * Measure every package's source and test lines.
 *
 * @param root - The tree to measure.
 * @returns Package to counts, for every package with any `.ts`/`.tsx` file.
 */
export function measure(root: string): Record<string, Lines> {
  // Untracked files too, so a local run agrees with CI before `git add`.
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  ).split('\0');
  const files = new Set(listed.filter((file) => file && !SKIPPED_FILE.test(file)));

  const counts: Record<string, Lines> = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const entry = (counts[packageOf(file)] ??= { source: 0, test: 0 });
    if (isTestFile(file)) entry.test += countLines(text);
    else entry.source += countLines(text);
  }
  return sortKeys(counts);
}

/**
 * The packages the ceiling applies to: not too small, not a test tier.
 *
 * @param counts - What {@link measure} found.
 */
export function measured(counts: Record<string, Lines>): Record<string, Lines> {
  return Object.fromEntries(
    Object.entries(counts).filter(
      ([pkg, lines]) => lines.source >= MIN_SOURCE_LINES && !TEST_TIER_PACKAGES.has(pkg)
    )
  );
}

/**
 * The ceiling a package's counts set when a baseline is written or lowered:
 * `HEADROOM_LINES` above today, the ratio never below `MIN_CEILING`.
 *
 * @param lines - One package's counts.
 */
export function ceilingFor(lines: Lines): Ceiling {
  const tests = lines.test + HEADROOM_LINES;
  return { ratio: Math.max(MIN_CEILING, ratioOf({ source: lines.source, test: tests })), tests };
}

/**
 * The ceiling a package new to the baseline gets: as {@link ceilingFor}, but no
 * looser than one line of test per line of source on either part.
 *
 * @param lines - One package's counts.
 */
export function newCeilingFor(lines: Lines): Ceiling {
  const c = ceilingFor(lines);
  const cap = Math.floor(NEW_PACKAGE_CEILING * lines.source);
  return { ratio: Math.min(NEW_PACKAGE_CEILING, c.ratio), tests: Math.min(cap, c.tests) };
}

/**
 * Whether counts are past both parts of a ceiling.
 *
 * @param lines - One package's counts.
 * @param c - Its ceiling.
 */
export function isOver(lines: Lines, c: Ceiling): boolean {
  return lines.test > c.tests && ratioOf(lines) > c.ratio;
}

/**
 * Compare today's counts with the ceilings.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's packages.
 */
export function compare(
  counts: Record<string, Lines>,
  baseline: Record<string, Ceiling>
): Finding[] {
  const findings: Finding[] = [];
  for (const [pkg, lines] of Object.entries(measured(counts))) {
    const ceiling = baseline[pkg];
    if (ceiling === undefined) {
      if (ratioOf(lines) > NEW_PACKAGE_CEILING) findings.push({ kind: 'new', pkg, lines });
    } else if (isOver(lines, ceiling)) {
      findings.push({ kind: 'over', pkg, lines, ceiling });
    }
  }
  return findings;
}

/**
 * Ceilings loosened against the base: either part higher, a new entry looser
 * than {@link newCeilingFor}, or an entry removed while still measured.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 * @param counts - What {@link measure} found on this tree.
 */
export function raisedAgainst(
  current: Record<string, Ceiling>,
  base: Record<string, Ceiling>,
  counts: Record<string, Lines>
): Finding[] {
  const inScope = measured(counts);
  const findings: Finding[] = [];
  for (const [pkg, c] of Object.entries(current)) {
    const before = base[pkg];
    const lines = inScope[pkg];
    const limit = before ?? (lines ? newCeilingFor(lines) : undefined);
    if (!limit || c.ratio > limit.ratio || c.tests > limit.tests) {
      findings.push({ kind: 'raised', pkg, loosened: c, ...(before && { ceiling: before }) });
    }
  }
  for (const [pkg, before] of Object.entries(base)) {
    if (!(pkg in current) && pkg in inScope)
      findings.push({ kind: 'dropped', pkg, ceiling: before });
  }
  return findings;
}

/**
 * The baseline after `--update`. Each part of each ceiling is lowered to
 * {@link ceilingFor} (never raised), a package no longer measured is removed,
 * and a measured package with no ceiling is added at {@link newCeilingFor}.
 * With `only`, every other entry is left exactly as it was, so a prune PR edits
 * one entry and does not collide with another PR's update.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's packages.
 * @param only - The one package to lower or add, when given.
 */
export function lowered(
  counts: Record<string, Lines>,
  baseline: Record<string, Ceiling>,
  only?: string
): Record<string, Ceiling> {
  const inScope = measured(counts);
  const next: Record<string, Ceiling> = {};
  for (const [pkg, c] of Object.entries(baseline)) {
    const lines = inScope[pkg];
    if (only !== undefined && pkg !== only) next[pkg] = c;
    else if (lines) {
      const fresh = ceilingFor(lines);
      next[pkg] = { ratio: Math.min(c.ratio, fresh.ratio), tests: Math.min(c.tests, fresh.tests) };
    }
  }
  for (const [pkg, lines] of Object.entries(inScope)) {
    if (pkg in baseline || (only !== undefined && pkg !== only)) continue;
    next[pkg] = newCeilingFor(lines);
  }
  return sortKeys(next);
}

/**
 * One line a person can act on.
 *
 * @param f - The finding.
 */
export function describe(f: Finding): string {
  const prune =
    'Delete weaker tests first: the rubric is in .claude/rules/testing.md, "Is this test worth keeping?".';
  const now = f.lines
    ? `${f.lines.test} lines of test, ${ratioOf(f.lines)} per line of source`
    : '';
  const held = f.ceiling ? `${f.ceiling.tests} lines or ${f.ceiling.ratio} per line` : '';
  switch (f.kind) {
    case 'over':
      return `${f.pkg}: ${now}, past its budget of ${held}. ${prune}`;
    case 'new':
      return `${f.pkg}: ${now}. A package new to the budget starts at ${NEW_PACKAGE_CEILING} per line. ${prune}`;
    case 'raised':
      return `${f.pkg}: budget loosened to ${f.loosened?.tests} lines or ${f.loosened?.ratio} per line${held ? ` (was ${held})` : ''}. Budgets only tighten; let \`--update\` write them.`;
    case 'dropped':
      return `${f.pkg}: its budget of ${held} was removed, but the package is still measured. Put it back; only \`--update\` removes one.`;
  }
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Parse a baseline file's text.
 *
 * @param text - The file's contents.
 * @param where - Where it came from, for the error message.
 */
export function readBaseline(text: string, where: string): Record<string, Ceiling> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TestRatioError(`${where} is not valid JSON`);
  }
  const packages = (parsed as Partial<Baseline>)?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new TestRatioError(`${where} has no packages map`);
  }
  for (const [pkg, c] of Object.entries(packages)) {
    const { ratio, tests } = (c ?? {}) as Partial<Ceiling>;
    const twoDecimals =
      typeof ratio === 'number' && Math.abs(Math.round(ratio * 100) - ratio * 100) <= 1e-6;
    if (!twoDecimals || !(ratio > 0) || !Number.isInteger(tests) || !((tests as number) > 0)) {
      throw new TestRatioError(
        `${where}: ${pkg} must be { ratio: a number above zero with two decimals at most, tests: a whole number above zero }`
      );
    }
  }
  return packages as Record<string, Ceiling>;
}

function writeBaseline(root: string, packages: Record<string, Ceiling>): void {
  const body: Baseline = { $comment: COMMENT, packages };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The baseline as it was at `ref`, or `null` when that tree had none. A ref
 * git cannot resolve is a failure to measure, never a skipped check.
 */
function baselineAt(root: string, ref: string): Record<string, Ceiling> | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new TestRatioError(`--base ${ref} is not a commit this checkout has`);
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

function printReport(counts: Record<string, Lines>, baseline: Record<string, Ceiling>): void {
  const inScope = measured(counts);
  let source = 0;
  let test = 0;
  for (const [pkg, lines] of Object.entries(counts)) {
    source += lines.source;
    test += lines.test;
    const ratio = pkg in inScope ? String(ratioOf(lines)) : 'not measured';
    const c = baseline[pkg];
    const held = c ? ` (budget ${c.tests} lines or ${c.ratio})` : '';
    console.log(`  ${pkg}: ${lines.test} test / ${lines.source} source = ${ratio}${held}`);
  }
  if (source > 0) {
    console.log(`  repo: ${test} test / ${source} source = ${ratioOf({ source, test })}`);
  }
}

function main(argv: string[]): number {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = resolve(value('--root') ?? process.cwd());
  const counts = measure(root);

  if (flag('--init')) {
    // Today's state is the starting point, so even a package past one line of
    // test per line of source starts at its own numbers here.
    const entries = Object.entries(measured(counts));
    writeBaseline(root, Object.fromEntries(entries.map(([pkg, l]) => [pkg, ceilingFor(l)])));
    console.log(`test-ratio: wrote ${entries.length} package budget(s)`);
    return 0;
  }

  let baselineText: string;
  try {
    baselineText = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new TestRatioError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(baselineText, BASELINE_PATH);

  if (flag('--report')) printReport(counts, baseline);

  if (flag('--update')) {
    const only = value('--package');
    if (only !== undefined && !(only in counts)) {
      throw new TestRatioError(`--package ${only} has no .ts or .tsx files`);
    }
    const next = lowered(counts, baseline, only);
    writeBaseline(root, next);
    console.log(`test-ratio: baseline holds ${Object.keys(next).length} package budget(s)`);
    // Lowering never excuses a package over its budget; say so rather than hide it.
    const left = compare(counts, next);
    for (const f of left) console.error(`  ${describe(f)}`);
    return left.length ? 1 : 0;
  }

  const findings = compare(counts, baseline);
  const base = value('--base');
  if (base) {
    const before = baselineAt(root, base);
    if (before) findings.push(...raisedAgainst(baseline, before, counts));
  }

  if (findings.length === 0) {
    console.log('test-ratio: clean. Every package is within its test budget.');
    return 0;
  }
  console.error(`test-ratio: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`test-ratio: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
