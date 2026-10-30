/**
 * Hold the client to its design tokens: a row either bans a pattern outright or
 * ratchets it, so a count per file may fall and never rise.
 *
 * WHY THIS EXISTS. The UI overhaul's Phase 1 moves colour, type and motion onto
 * tokens, and its Phase 2 sweeps the old call sites. Without a gate the sweep
 * would be chasing new ones. Each row names the pattern a token replaced.
 *
 * WHAT FAILS (exit 1):
 *   - banned:  a `hard` row matched anywhere in its scope;
 *   - grew:    a `ratchet` row counts more in a file than the baseline holds;
 *   - stale:   a file's count fell and the baseline still says the old number.
 *              Run `--update`, which only ever lowers or removes entries;
 *   - raised:  with `--base <ref>`, an entry is higher than the base's. The
 *              baseline is lowered by `--update`, never raised by hand.
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad base): a gate that
 * cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:design-tokens                  check against the baseline
 *   pnpm check:design-tokens -- --base <ref>  also refuse a raised baseline
 *   pnpm check:design-tokens -- --update      lower or remove entries
 *   pnpm check:design-tokens -- --init        write the baseline from scratch
 *   pnpm check:design-tokens -- --root <dir>  measure another tree (tests)
 *
 * @module scripts/check-design-tokens
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/design-tokens/baseline.json';

/** Tests and the dev playground may spell anything out. */
const EXEMPT = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$|^apps\/client\/src\/dev\//;

/** One thing the gate watches for. */
export interface Row {
  /** The row's name in the baseline and in messages. */
  id: string;
  /** `hard` allows none; `ratchet` allows what the baseline holds. */
  mode: 'hard' | 'ratchet';
  /** Paths git lists for this row, relative to the root. */
  paths: string[];
  /** Files the row never applies to. */
  skip?: RegExp;
  /** How many matches a file's text holds. */
  count: (text: string) => number;
  /** What to do instead. */
  hint: string;
}

/** Remove CSS comments, so a comment that names a curve is not that curve. */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Whether a `cubic-bezier(x1, y1, x2, y2)` leaves 0..1 on the y axis, so overshoots. */
function overshoots(args: string): boolean {
  const [, y1, , y2] = args.split(',').map(Number);
  return y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1;
}

/** Every row. Add one here to guard another token. */
export const ROWS: Row[] = [
  {
    id: 'spring-literal',
    mode: 'ratchet',
    paths: ['apps/client/src', 'packages/ui/src'],
    skip: /^apps\/client\/src\/layers\/shared\/lib\/motion\.ts$/,
    count: (text) => text.match(/\bstiffness:/g)?.length ?? 0,
    hint: 'use SPRING from shared/lib/motion.ts',
  },
  {
    id: 'overshoot-bezier',
    mode: 'hard',
    paths: ['apps/client/src/index.css'],
    // `reaction-pop` is the one overshoot a reaction gets (spec D6).
    count: (text) =>
      stripCssComments(text)
        .split('\n')
        .filter((line) => !line.includes('reaction-pop'))
        .flatMap((line) => [...line.matchAll(/cubic-bezier\(([^)]+)\)/g)])
        .filter((match) => overshoots(match[1])).length,
    hint: 'use var(--ease-out), var(--ease-in) or var(--ease-standard)',
  },
];

/** The baseline: for each ratchet row, each file's count when last measured. */
export type Counts = Record<string, Record<string, number>>;

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the gate was broken. */
  kind: 'banned' | 'grew' | 'stale' | 'raised';
  /** The row it belongs to. */
  row: string;
  /** The repo-relative file. */
  file: string;
  /** The file's count now. */
  count?: number;
  /** The number the baseline holds. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class DesignTokensError extends Error {}

const COMMENT =
  'The design-token ratchet (scripts/check-design-tokens.ts). Counts per file may fall, never rise. Run `pnpm check:design-tokens -- --update` after lowering one; never raise a number by hand.';

/**
 * Count every row in every file it covers.
 *
 * @param root - The tree to measure.
 * @param rows - The rows to count.
 * @returns Row id to repo-relative file to its count, with no zero counts.
 */
export function measure(root: string, rows: Row[] = ROWS): Counts {
  const counts: Counts = {};
  for (const row of rows) {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...row.paths],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    ).split('\0');
    const found: Record<string, number> = {};
    for (const file of [...new Set(files)].sort()) {
      if (!/\.(ts|tsx|css)$/.test(file) || EXEMPT.test(file) || row.skip?.test(file)) continue;
      let text: string;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      const n = row.count(text);
      if (n > 0) found[file] = n;
    }
    counts[row.id] = found;
  }
  return counts;
}

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline.
 * @param rows - The rows, for their modes.
 */
export function compare(counts: Counts, baseline: Counts, rows: Row[] = ROWS): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const found = counts[row.id] ?? {};
    if (row.mode === 'hard') {
      for (const [file, count] of Object.entries(found)) {
        findings.push({ kind: 'banned', row: row.id, file, count });
      }
      continue;
    }
    const held = baseline[row.id] ?? {};
    for (const [file, count] of Object.entries(found)) {
      const before = held[file] ?? 0;
      if (count > before)
        findings.push({ kind: 'grew', row: row.id, file, count, baseline: before });
      else if (count < before) {
        findings.push({ kind: 'stale', row: row.id, file, count, baseline: before });
      }
    }
    for (const [file, before] of Object.entries(held)) {
      if (!(file in found)) {
        findings.push({ kind: 'stale', row: row.id, file, count: 0, baseline: before });
      }
    }
  }
  return findings;
}

/**
 * Entries the baseline raised or added against its base.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(current: Counts, base: Counts): Finding[] {
  const findings: Finding[] = [];
  for (const [row, files] of Object.entries(current)) {
    // A row the base has never heard of is being introduced, not raised.
    if (!(row in base)) continue;
    for (const [file, count] of Object.entries(files)) {
      const before = base[row][file] ?? 0;
      if (count > before) findings.push({ kind: 'raised', row, file, count, baseline: before });
    }
  }
  return findings;
}

/**
 * The baseline after `--update`: every entry lowered to its count, nothing
 * raised, nothing added.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline.
 */
export function lowered(counts: Counts, baseline: Counts): Counts {
  const next: Counts = {};
  for (const [row, files] of Object.entries(baseline)) {
    next[row] = {};
    for (const [file, held] of Object.entries(files)) {
      const count = counts[row]?.[file];
      if (count) next[row][file] = Math.min(held, count);
    }
  }
  return next;
}

/** One line a person can act on. */
export function describe(f: Finding, rows: Row[] = ROWS): string {
  const hint = rows.find((row) => row.id === f.row)?.hint;
  switch (f.kind) {
    case 'banned':
      return `${f.file}: ${f.count} ${f.row} match(es), and none are allowed: ${hint}.`;
    case 'grew':
      return `${f.file}: ${f.row} rose to ${f.count} (baseline ${f.baseline}): ${hint}.`;
    case 'stale':
      return `${f.file}: ${f.row} fell to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:design-tokens -- --update\` to lock that in.`;
    case 'raised':
      return `${f.file}: ${f.row} baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down: ${hint}.`;
  }
}

function readBaseline(text: string, where: string): Counts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DesignTokensError(`${where} is not valid JSON`);
  }
  const rows = (parsed as { rows?: Counts })?.rows;
  if (!rows || typeof rows !== 'object') throw new DesignTokensError(`${where} has no rows map`);
  return rows;
}

function writeBaseline(root: string, rows: Counts): void {
  const body = { $comment: COMMENT, rows };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/** The baseline as it was at `ref`, or `{}` when that tree had none. */
function baselineAt(root: string, ref: string): Counts {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new DesignTokensError(`--base ${ref} is not a commit this checkout has`);
  }
  let text: string;
  try {
    text = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {};
  }
  return readBaseline(text, `${BASELINE_PATH} at ${ref}`);
}

function main(argv: string[]): number {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = resolve(value('--root') ?? process.cwd());
  const counts = measure(root);

  if (argv.includes('--init')) {
    const ratchets = ROWS.filter((row) => row.mode === 'ratchet');
    writeBaseline(root, Object.fromEntries(ratchets.map((row) => [row.id, counts[row.id]])));
    console.log(`design-tokens: wrote ${BASELINE_PATH}`);
    return 0;
  }

  let text: string;
  try {
    text = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new DesignTokensError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(text, BASELINE_PATH);

  if (argv.includes('--update')) {
    const next = lowered(counts, baseline);
    writeBaseline(root, next);
    const left = compare(counts, next);
    for (const f of left) console.error(`  ${describe(f)}`);
    return left.length ? 1 : 0;
  }

  const findings = compare(counts, baseline);
  const base = value('--base');
  if (base) findings.push(...raisedAgainst(baseline, baselineAt(root, base)));

  if (findings.length === 0) {
    console.log('design-tokens: clean.');
    return 0;
  }
  console.error(`design-tokens: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`design-tokens: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
