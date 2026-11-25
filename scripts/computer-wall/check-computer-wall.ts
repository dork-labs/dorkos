/**
 * Hold the computer wall's baseline to its own rules (spec
 * `computer-side-starts-alone` §4, DOR-5158): what a computer-side file still
 * imports from the space side, the front door and the space tables may only
 * go, and the numbers in `apps/server/eslint-rules/computer-wall.baseline.json`
 * may only fall.
 *
 * WHY THIS EXISTS. The ESLint rule (`apps/server/eslint-rules/computer-wall.js`)
 * refuses, file by file and column by column, an import past its entry and a
 * drop its entry has not locked in. It cannot see a baseline raised by hand
 * (the rule would read the raised number and pass), an entry for a file that
 * no longer exists, or a side map that places one path twice or names a path
 * that is gone. This script measures what the rule does, with the rule's own
 * classifier, and checks all of them.
 *
 * WHAT COUNTS, per non-test computer-side file (§1.2):
 *   - space, frontDoor: every `import`, `export … from`, `import x = require`,
 *     literal `import()`, `import('…')` type and `declare module` whose relative
 *     specifier resolves into a space-side or front-door path. The specifiers
 *     are read by TypeScript's own pre-processor (without its guesses at
 *     JavaScript `require()` calls, which the rule does not count either);
 *   - tables: each name imported or re-exported from `@dorkos/db` that is on
 *     the side map's space table list.
 *
 * WHAT FAILS (exit 1):
 *   - grew:     a column holds more than the file's entry;
 *   - new:      a file with no entry holds any;
 *   - stale:    a column holds less than its entry, or the file has none left
 *               (or is gone) while the baseline still lists it. Run `--update`,
 *               which only lowers or removes entries, so the gain cannot be
 *               spent later;
 *   - raised:   with `--base <ref>`, an entry's column is higher than the
 *               base's, or the file is new to the baseline;
 *   - unplaced: a non-test file under services/ that no side map path places;
 *   - sides:    the side map places a path twice, names a path that does not
 *               exist, or puts a table on both lists.
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad `--base`): a
 * gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:computer-wall                      check against the baseline
 *   pnpm check:computer-wall -- --base <ref>      also refuse a raised baseline
 *   pnpm check:computer-wall -- --update          lower and remove entries
 *   pnpm check:computer-wall -- --init            write the baseline from scratch
 *   pnpm check:computer-wall -- --root <dir>      measure another checkout of this tree
 *
 * @module scripts/computer-wall/check-computer-wall
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  COLUMNS,
  DB_PACKAGE,
  GATE_NOTE_FOLDERS,
  crossing,
  inServices,
  isSpaceTable,
  isTestPath,
  readSides,
  sideOf,
  type Column,
} from '../../apps/server/eslint-rules/computer-wall.js';

/** The server package, relative to the root. */
const SERVER = 'apps/server';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = `${SERVER}/eslint-rules/computer-wall.baseline.json`;

/** One file's three columns. */
export type Counts = Record<Column, number>;

/** The baseline file: each computer-side file's columns when last measured. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** File, relative to the server package, to its columns; sorted by path. */
  files: Record<string, Counts>;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the ratchet was broken. */
  kind: 'grew' | 'new' | 'stale' | 'raised' | 'unplaced' | 'sides';
  /** The file (relative to the server package), or the side map path or table. */
  file: string;
  /** The column, for a count finding. */
  column?: Column;
  /** Its count now, when it has one. */
  count?: number;
  /** The number the baseline holds for it. */
  baseline?: number;
  /** What is wrong, for a side map finding. */
  detail?: string;
}

/** A thrown failure that means "could not measure", exit 2. */
export class ComputerWallError extends Error {}

const COMMENT =
  'The computer wall (apps/server/eslint-rules/computer-wall.js, spec computer-side-starts-alone §4, DOR-5158). For each computer-side file: space, its imports of space-side code; frontDoor, its imports of front-door code; tables, the space tables it names from @dorkos/db. Each may only fall. Run `pnpm check:computer-wall -- --update` after removing some; never raise a number by hand.';

const ZERO: Counts = { space: 0, frontDoor: 0, tables: 0 };

/**
 * Count one computer-side file's three columns.
 *
 * @param absolutePath - The file, absolute, so its specifiers resolve against it.
 * @param text - Its source.
 */
export function countFile(absolutePath: string, text: string): Counts {
  const counts: Counts = { ...ZERO };
  const { importedFiles } = ts.preProcessFile(text, true, false);
  for (const ref of importedFiles) {
    const column = crossing(absolutePath, ref.fileName);
    if (column) counts[column] += 1;
  }
  counts.tables = spaceTableNames(absolutePath, text).length;
  return counts;
}

/**
 * The space tables a file imports or re-exports by name from `@dorkos/db`.
 *
 * @param fileName - The file's name, for the parser.
 * @param text - Its source.
 */
export function spaceTableNames(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const names: string[] = [];
  for (const statement of source.statements) {
    let elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier> | undefined;
    let from: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement)) {
      from = statement.moduleSpecifier;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) elements = bindings.elements;
    } else if (ts.isExportDeclaration(statement)) {
      from = statement.moduleSpecifier;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        elements = statement.exportClause.elements;
    }
    if (!from || !ts.isStringLiteral(from) || from.text !== DB_PACKAGE || !elements) continue;
    for (const element of elements) {
      const name = (element.propertyName ?? element.name).text;
      if (isSpaceTable(name)) names.push(name);
    }
  }
  return names;
}

/** Every non-test file under `services/`, relative to the root, untracked ones included. */
function serviceFiles(root: string): string[] {
  // Untracked files too, so a local run agrees with CI before `git add`.
  return execFileSync(
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
    .filter((file, i, all) => file && !isTestPath(file) && all.indexOf(file) === i)
    .filter((file) => existsSync(resolve(root, file))); // deleted in the working tree
}

/** What one pass over the tree found. */
export interface Measure {
  /** File (relative to the server package) to columns, for files with any. */
  counts: Record<string, Counts>;
  /** Files under services/ the side map does not place, relative to the server package. */
  unplaced: string[];
  /** The `space` column's imports from runtimes into the gate note's five folders (§4). */
  gateNote: number;
}

/**
 * Measure every computer-side file's columns.
 *
 * @param root - The tree to measure.
 */
export function measure(root: string): Measure {
  const counts: Record<string, Counts> = {};
  const unplaced: string[] = [];
  let gateNote = 0;
  for (const file of serviceFiles(root)) {
    const absolute = resolve(root, file);
    const rel = file.slice(SERVER.length + 1);
    const side = sideOf(absolute);
    if (side === 'unplaced') unplaced.push(rel);
    if (side !== 'computer') continue;
    const text = readFileSync(absolute, 'utf8');
    const n = countFile(absolute, text);
    if (n.space + n.frontDoor + n.tables > 0) counts[rel] = n;
    if (inServices(absolute)?.startsWith('runtimes/')) {
      gateNote += ts
        .preProcessFile(text, true, false)
        .importedFiles.map((ref) => ref.fileName)
        .filter((specifier) => crossing(absolute, specifier) === 'space')
        .map((specifier) => inServices(resolve(dirname(absolute), specifier)) ?? '')
        .filter((to) => GATE_NOTE_FOLDERS.some((f) => to === f || to.startsWith(`${f}/`))).length;
    }
  }
  return { counts: sortKeys(counts), unplaced: unplaced.sort(), gateNote };
}

/**
 * What is wrong with the side map itself: a path placed twice, a path that
 * does not exist, a table on both lists or twice.
 *
 * @param root - The tree whose `services/` the paths must exist in.
 * @param sides - The side map, as {@link readSides} reads it.
 */
export function checkSides(root: string, sides: ReturnType<typeof readSides>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  for (const [side, paths] of Object.entries(sides.sides)) {
    for (const path of paths) {
      const other = seen.get(path);
      if (other) findings.push({ kind: 'sides', file: path, detail: `on ${other} and ${side}` });
      seen.set(path, side);
      const absolute = join(root, SERVER, 'src/services', path);
      const isFile = /\.tsx?$/u.test(path);
      const real = existsSync(absolute) && statSync(absolute).isFile() === isFile;
      if (!real)
        findings.push({
          kind: 'sides',
          file: path,
          detail: `no such ${isFile ? 'file' : 'folder'}`,
        });
    }
  }
  const tables = new Map<string, string>();
  for (const [list, names] of Object.entries(sides.tables)) {
    for (const name of names) {
      const other = tables.get(name);
      if (other)
        findings.push({ kind: 'sides', file: name, detail: `on the ${other} and ${list} tables` });
      tables.set(name, list);
    }
  }
  return findings;
}

/**
 * Compare measured counts with the baseline, column by column.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's files.
 */
export function compare(
  counts: Record<string, Counts>,
  baseline: Record<string, Counts>
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, now] of Object.entries(counts)) {
    const held = baseline[file];
    for (const column of COLUMNS) {
      const count = now[column];
      if (held === undefined) {
        if (count > 0) findings.push({ kind: 'new', file, column, count });
        continue;
      }
      if (count > held[column])
        findings.push({ kind: 'grew', file, column, count, baseline: held[column] });
      else if (count < held[column])
        findings.push({ kind: 'stale', file, column, count, baseline: held[column] });
    }
  }
  for (const [file, held] of Object.entries(baseline)) {
    if (!(file in counts)) findings.push({ kind: 'stale', file, baseline: total(held) });
  }
  return findings;
}

/**
 * Entries the baseline raised against its base: a column higher than before,
 * or a file that was not in it.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(
  current: Record<string, Counts>,
  base: Record<string, Counts>
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, held] of Object.entries(current)) {
    const before = base[file];
    if (before === undefined) {
      findings.push({ kind: 'raised', file, count: total(held) });
      continue;
    }
    for (const column of COLUMNS) {
      if (held[column] > before[column])
        findings.push({
          kind: 'raised',
          file,
          column,
          count: held[column],
          baseline: before[column],
        });
    }
  }
  return findings;
}

/**
 * The baseline after `--update`: every column lowered to its count, files at
 * zero removed, nothing raised and nothing added.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's files.
 */
export function lowered(
  counts: Record<string, Counts>,
  baseline: Record<string, Counts>
): Record<string, Counts> {
  const next: Record<string, Counts> = {};
  for (const [file, held] of Object.entries(baseline)) {
    const now = counts[file];
    if (now === undefined) continue;
    const entry = { ...ZERO };
    for (const column of COLUMNS) entry[column] = Math.min(held[column], now[column]);
    if (total(entry) > 0) next[file] = entry;
  }
  return sortKeys(next);
}

/**
 * One line a person can act on.
 *
 * @param f - The finding.
 */
export function describe(f: Finding): string {
  const what = f.column ? `${f.column} ${f.count}` : `${f.count}`;
  switch (f.kind) {
    case 'grew':
      return `${f.file}: ${what} (baseline ${f.baseline}). Reach the space side through a port; move a shared type to packages/shared.`;
    case 'new':
      return `${f.file}: ${what}, and this file had none. Reach the space side through a port instead.`;
    case 'stale':
      return f.column === undefined
        ? `${f.file}: nothing left to count. Run \`pnpm check:computer-wall -- --update\` to drop it from the baseline.`
        : `${f.file}: ${f.column} down to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:computer-wall -- --update\` to lock that in.`;
    case 'raised':
      return f.baseline === undefined
        ? `${f.file}: added to the baseline. The baseline is never added to by hand.`
        : `${f.file}: ${f.column} raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
    case 'unplaced':
      return `${f.file}: in no folder of the side map. Give its folder a side in ${SERVER}/eslint-rules/sides.json.`;
    case 'sides':
      return `${SERVER}/eslint-rules/sides.json: ${f.file} is ${f.detail}.`;
  }
}

/**
 * The totals a person reads: each column's sum and how many files hold it.
 *
 * @param counts - Measured or baselined columns.
 */
export function summary(counts: Record<string, Counts>): string {
  return COLUMNS.map((column) => {
    const files = Object.values(counts).filter((n) => n[column] > 0);
    return `${column} ${files.reduce((sum, n) => sum + n[column], 0)} in ${files.length} file(s)`;
  }).join(', ');
}

function total(n: Counts): number {
  return n.space + n.frontDoor + n.tables;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(text: string, where: string): Record<string, Counts> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ComputerWallError(`${where} is not valid JSON`);
  }
  const files = (parsed as Partial<Baseline>)?.files;
  if (!files || typeof files !== 'object') throw new ComputerWallError(`${where} has no files map`);
  for (const [file, entry] of Object.entries(files)) {
    const columns = Object.keys(entry ?? {});
    const whole = COLUMNS.every((c) => Number.isInteger(entry?.[c]) && entry[c] >= 0);
    if (!whole || columns.length !== COLUMNS.length || total(entry) === 0) {
      throw new ComputerWallError(
        `${where}: ${file} must hold ${COLUMNS.join(', ')} as whole numbers, not all zero`
      );
    }
  }
  return files;
}

function writeBaseline(root: string, files: Record<string, Counts>): void {
  const body: Baseline = { $comment: COMMENT, files };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The baseline as it was at `ref`, or `null` when that tree had none. A ref
 * git cannot resolve is a failure to measure, never a skipped check.
 */
function baselineAt(root: string, ref: string): Record<string, Counts> | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new ComputerWallError(`--base ${ref} is not a commit this checkout has`);
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
  const { counts, unplaced, gateNote } = measure(root);
  const problems: Finding[] = [
    ...checkSides(root, readSides()),
    ...unplaced.map((file): Finding => ({ kind: 'unplaced', file })),
  ];

  if (flag('--init')) {
    writeBaseline(root, counts);
    console.log(`computer-wall: wrote ${summary(counts)}`);
    for (const f of problems) console.error(`  ${describe(f)}`);
    return problems.length ? 1 : 0;
  }

  let baselineText: string;
  try {
    baselineText = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new ComputerWallError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(baselineText, BASELINE_PATH);

  if (flag('--update')) {
    const next = lowered(counts, baseline);
    writeBaseline(root, next);
    console.log(`computer-wall: baseline holds ${summary(next)}`);
    // Lowering never excuses growth or a new file; say so rather than hide it.
    const left = [...problems, ...compare(counts, next).filter((f) => f.kind !== 'stale')];
    for (const f of left) console.error(`  ${describe(f)}`);
    return left.length ? 1 : 0;
  }

  const findings = [...problems, ...compare(counts, baseline)];
  const base = value('--base');
  if (base) {
    const before = baselineAt(root, base);
    if (before) findings.push(...raisedAgainst(baseline, before));
  }

  if (findings.length === 0) {
    console.log(`computer-wall: clean. ${summary(counts)}; none added.`);
    console.log(
      `computer-wall: runtimes into ${GATE_NOTE_FOLDERS.join(', ')} (the gate note's ratchet): ${gateNote}.`
    );
    return 0;
  }
  console.error(`computer-wall: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`computer-wall: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
