/**
 * Hold the services import boundary's baseline to its own rules (DOR-4924):
 * the imports from one `services/` domain into another may only go, and the
 * counts in `apps/server/eslint-rules/import-boundary.baseline.json` may only
 * fall.
 *
 * --help
 * Purpose: hold the services import boundary's baseline to its rules: imports
 *          between `services/` domains may only go, and counts only fall.
 * Runs in: `pnpm ratchet` (pre-push; the required `typecheck` job).
 * To fix:  remove the import it names. After removing some, run
 *          `pnpm check:import-boundary -- --update`. Never add or raise a pair.
 * Usage:   pnpm check:import-boundary [-- --base <ref> | --update | --init | --root <dir>]
 * --help end
 *
 * WHY THIS EXISTS. The ESLint rule (`apps/server/eslint-rules/import-boundary.js`)
 * refuses an import whose pair (`from -> to`) is not in the baseline. It cannot
 * see a pair's count grow, a pair added or raised by hand (the rule would read
 * it and pass), or a pair that is gone. This script measures what the rule
 * does, with the rule's own classifier (`edgeOf`), and checks all of them.
 *
 * WHAT COUNTS, per non-test file under services/: every `import`,
 * `export … from`, `import x = require`, literal `import()` and
 * `declare module` whose relative specifier resolves into another domain
 * under services/, side-effect imports included. Type-only statements are not
 * counted (`import type`, `export type … from`, every specifier an inline
 * `type`, `import type x = require`, an `import('…')` type), so the
 * statements are read from TypeScript's syntax tree: its pre-processor cannot
 * tell a type-only import apart.
 *
 * WHAT FAILS (exit 1): new (a pair the baseline does not hold); grew (a pair
 * past its count); stale (a pair below its count, or gone: run `--update`,
 * which only lowers or removes, so the gain cannot be spent later); raised
 * (with `--base <ref>`, a pair added or a count higher than the base's).
 *
 * Exit 2 means it could not run (an unreadable baseline, a bad `--base`): a
 * gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:import-boundary                    check against the baseline
 *   pnpm check:import-boundary -- --base <ref>    also refuse a raised baseline
 *   pnpm check:import-boundary -- --update        lower and remove pairs
 *   pnpm check:import-boundary -- --init          write the baseline from scratch
 *   pnpm check:import-boundary -- --root <dir>    measure another checkout of this tree
 *
 * @module scripts/import-boundary/check-import-boundary
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isTestPath } from '../../apps/server/eslint-rules/computer-wall.js';
import {
  COMPOSITION_ROOTS,
  PORTS,
  domainOf,
  edgeOf,
  portLeak,
} from '../../apps/server/eslint-rules/import-boundary.js';
import { exitOnHelp } from '../lib/gate-help.mjs';

/** The server package, relative to the root. */
const SERVER = 'apps/server';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = `${SERVER}/eslint-rules/import-boundary.baseline.json`;

/** Each pair (`from -> to`) to the number of statements that make it. */
export type Edges = Record<string, number>;

/** The baseline file. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** Each pair to its count when last measured; sorted by pair. */
  edges: Edges;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the ratchet was broken. */
  kind: 'new' | 'grew' | 'stale' | 'raised' | 'port' | 'list';
  /** The pair, `from -> to`, or the listed path for a `list` finding. */
  pair: string;
  /** The port file that leaks, or what is wrong with a list entry. */
  detail?: string;
  /** Its count now, when it has one. */
  count?: number;
  /** The number the baseline (or the base's baseline) holds for it. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class ImportBoundaryError extends Error {}

const COMMENT =
  'The services import boundary (apps/server/eslint-rules/import-boundary.js, DOR-4924). Each pair is one services/ domain importing another (each folder under core/ is its own domain), with the number of non-test, non-type-only import statements that make it. The lint rule refuses a pair not listed here; the counts may only fall. Run `pnpm check:import-boundary -- --update` after removing some; never add a pair or raise a number by hand. A PR that moves a folder updates this file and sides.json together.';

const PAIR = /^\S+ -> \S+$/u;

/**
 * Whether an import's or export's named list is only inline `type` specifiers.
 *
 * @param elements - The named list, if the statement has one.
 */
function onlyInlineTypes(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier> | undefined
): boolean {
  return elements !== undefined && elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

/**
 * The relative and package specifiers of every statement in a file that can
 * carry code at run time: the forms the rule reads, without the type-only ones.
 *
 * @param fileName - The file's name, for the parser.
 * @param text - Its source.
 */
export function valueSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const add = (expression: ts.Node | undefined) => {
    if (expression && ts.isStringLiteral(expression)) found.push(expression.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            onlyInlineTypes(named.elements)));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined && ts.isNamedExports(clause) && onlyInlineTypes(clause.elements));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
        add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module '../x.js' { … }` augments a module and so depends on it.
      add(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The pairs one file makes, each with its number of statements.
 *
 * @param absolutePath - The file, absolute, so its specifiers resolve against it.
 * @param text - Its source.
 */
export function countFile(absolutePath: string, text: string): Edges {
  const edges: Edges = {};
  for (const specifier of valueSpecifiers(absolutePath, text)) {
    const pair = edgeOf(absolutePath, specifier);
    if (pair) edges[pair] = (edges[pair] ?? 0) + 1;
  }
  return edges;
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
  /** Each pair to its statements; sorted. */
  edges: Edges;
  /** Each pair to the files (relative to the server package) that make it. */
  files: Record<string, string[]>;
  /** Every domain a non-test file is in; sorted. */
  domains: string[];
  /** Pairs a port makes into another domain, which it never may. */
  leaks: Finding[];
}

/**
 * Measure every pair under `services/`.
 *
 * @param root - The tree to measure.
 */
export function measure(root: string): Measure {
  const edges: Edges = {};
  const files: Record<string, string[]> = {};
  const domains = new Set<string>();
  const leaks: Finding[] = [];
  for (const file of serviceFiles(root)) {
    const absolute = resolve(root, file);
    const domain = domainOf(absolute);
    if (domain !== null) domains.add(domain);
    const text = readFileSync(absolute, 'utf8');
    for (const specifier of valueSpecifiers(absolute, text)) {
      const leak = portLeak(absolute, specifier);
      if (leak) leaks.push({ kind: 'port', pair: leak, detail: file.slice(SERVER.length + 1) });
    }
    for (const [pair, n] of Object.entries(countFile(absolute, text))) {
      edges[pair] = (edges[pair] ?? 0) + n;
      (files[pair] ??= []).push(file.slice(SERVER.length + 1));
    }
  }
  return { edges: sortKeys(edges), files, domains: [...domains].sort(), leaks };
}

/**
 * Compare measured pairs with the baseline.
 *
 * @param edges - What {@link measure} found.
 * @param baseline - The committed baseline's pairs.
 */
export function compare(edges: Edges, baseline: Edges): Finding[] {
  const findings: Finding[] = [];
  for (const [pair, count] of Object.entries(edges)) {
    const held = baseline[pair];
    if (held === undefined) findings.push({ kind: 'new', pair, count });
    else if (count > held) findings.push({ kind: 'grew', pair, count, baseline: held });
    else if (count < held) findings.push({ kind: 'stale', pair, count, baseline: held });
  }
  for (const [pair, held] of Object.entries(baseline)) {
    if (!(pair in edges)) findings.push({ kind: 'stale', pair, count: 0, baseline: held });
  }
  return findings;
}

/**
 * Pairs the baseline raised against its base: a count higher than before, or
 * a pair that was not in it.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(current: Edges, base: Edges): Finding[] {
  const findings: Finding[] = [];
  for (const [pair, count] of Object.entries(current)) {
    const before = base[pair];
    if (before === undefined) findings.push({ kind: 'raised', pair, count });
    else if (count > before) findings.push({ kind: 'raised', pair, count, baseline: before });
  }
  return findings;
}

/**
 * The baseline after `--update`: every pair lowered to its count, pairs at
 * zero removed, nothing raised and nothing added.
 *
 * @param edges - What {@link measure} found.
 * @param baseline - The committed baseline's pairs.
 */
export function lowered(edges: Edges, baseline: Edges): Edges {
  const next: Edges = {};
  for (const [pair, held] of Object.entries(baseline)) {
    const n = Math.min(held, edges[pair] ?? 0);
    if (n > 0) next[pair] = n;
  }
  return sortKeys(next);
}

/**
 * What is wrong with the named ports and composition roots: an entry whose file does not exist,
 * or one with no reason or no record behind it.
 *
 * @param root - The tree whose `services/` the files must exist in.
 */
export function checkExceptions(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const entry of [...PORTS, ...COMPOSITION_ROOTS]) {
    const base = join(root, SERVER, 'src/services', entry.path);
    if (!['.ts', '.tsx'].some((ext) => existsSync(`${base}${ext}`)))
      findings.push({ kind: 'list', pair: entry.path, detail: 'no such file' });
    if (!entry.reason.trim() || !entry.record.trim())
      findings.push({ kind: 'list', pair: entry.path, detail: 'no reason or no record' });
  }
  return findings;
}

/**
 * One line a person can act on.
 *
 * @param f - The finding.
 * @param files - The files that make each pair, to name where to look.
 */
export function describe(f: Finding, files: Record<string, string[]> = {}): string {
  const where = files[f.pair]?.length ? ` (in ${files[f.pair]!.join(', ')})` : '';
  switch (f.kind) {
    case 'new':
      return `${f.pair}: ${f.count} import(s), and the baseline has no such pair${where}. Depend on an interface or port the other domain exports, or move a shared type to packages/shared.`;
    case 'grew':
      return `${f.pair}: ${f.count} imports (baseline ${f.baseline})${where}. Depend on an interface or port, or move a shared type to packages/shared.`;
    case 'stale':
      return f.count === 0
        ? `${f.pair}: gone. Run \`pnpm check:import-boundary -- --update\` to drop it from the baseline.`
        : `${f.pair}: down to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:import-boundary -- --update\` to lock that in.`;
    case 'port':
      return `${f.detail}: makes ${f.pair}, and it is a port. A port imports no other domain (PORTS in apps/server/eslint-rules/import-boundary.js).`;
    case 'list':
      return `apps/server/eslint-rules/import-boundary.js: the port or composition root ${f.pair} has ${f.detail}.`;
    case 'raised':
      return f.baseline === undefined
        ? `${f.pair}: added to the baseline. A pair is never added by hand.`
        : `${f.pair}: raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
  }
}

/**
 * The totals a person reads: pairs, the pairs both ways, and statements.
 *
 * @param edges - Measured or baselined pairs.
 */
export function summary(edges: Edges): string {
  const pairs = Object.keys(edges);
  const mutual = pairs.filter((pair) => {
    const [from, to] = pair.split(' -> ');
    return from! < to! && `${to} -> ${from}` in edges;
  }).length;
  const statements = Object.values(edges).reduce((sum, n) => sum + n, 0);
  return `${pairs.length} pairs (${mutual} both ways), ${statements} import statements`;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(text: string, where: string): Edges {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportBoundaryError(`${where} is not valid JSON`);
  }
  const edges = (parsed as Partial<Baseline>)?.edges;
  if (!edges || typeof edges !== 'object')
    throw new ImportBoundaryError(`${where} has no edges map`);
  for (const [pair, n] of Object.entries(edges)) {
    if (!PAIR.test(pair) || !Number.isInteger(n) || n < 1)
      throw new ImportBoundaryError(
        `${where}: ${pair} must be "from -> to" with a whole number above 0`
      );
  }
  return edges;
}

function writeBaseline(root: string, edges: Edges): void {
  const body: Baseline = { $comment: COMMENT, edges: sortKeys(edges) };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The baseline as it was at `ref`, or `null` when that tree had none (the
 * pull request that adds it). A ref git cannot resolve is a failure to
 * measure, never a skipped check.
 */
function baselineAt(root: string, ref: string): Edges | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new ImportBoundaryError(`--base ${ref} is not a commit this checkout has`);
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
  const { edges, files, domains, leaks } = measure(root);
  const problems = [...leaks, ...checkExceptions(root)];

  if (flag('--init')) {
    writeBaseline(root, edges);
    console.log(`import-boundary: wrote ${domains.length} domains, ${summary(edges)}`);
    for (const f of problems) console.error(`  ${describe(f, files)}`);
    return problems.length ? 1 : 0;
  }

  let baselineText: string;
  try {
    baselineText = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new ImportBoundaryError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = readBaseline(baselineText, BASELINE_PATH);

  if (flag('--update')) {
    const next = lowered(edges, baseline);
    writeBaseline(root, next);
    console.log(`import-boundary: baseline holds ${summary(next)}`);
    // Lowering never excuses growth or a new pair; say so rather than hide it.
    const left = [...problems, ...compare(edges, next).filter((f) => f.kind !== 'stale')];
    for (const f of left) console.error(`  ${describe(f, files)}`);
    return left.length ? 1 : 0;
  }

  const findings = [...problems, ...compare(edges, baseline)];
  const base = value('--base');
  if (base) {
    const before = baselineAt(root, base);
    if (before) findings.push(...raisedAgainst(baseline, before));
  }

  if (findings.length === 0) {
    console.log(
      `import-boundary: clean. ${domains.length} domains, ${summary(edges)}; none added.`
    );
    return 0;
  }
  console.error(`import-boundary: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f, files)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(import.meta.url);
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(
      `import-boundary: cannot run: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
  }
}
