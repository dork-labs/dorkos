/**
 * Hold every source and test file to the 500-line rule with a ratchet: nothing
 * over the limit may grow, nothing new may cross it, and the baseline only
 * goes down.
 *
 * WHY THIS EXISTS. `max-lines` (500, blank lines and comments skipped) has been
 * `warn` in `packages/eslint-config/base.js` since the rule was written, and a
 * warning fails nothing: every package's lint script is a bare `eslint .`. So
 * the rule was advice, files kept growing, and on 2026-10-09 about 395 of them
 * were over it, `apps/server/src/index.ts` at 6,635 (DOR-2822). Turning the
 * rule into an `error` would red the build on all of them at once. A ratchet
 * lets today's build stay green while making the number only ever fall.
 *
 * THE COUNT IS ESLINT'S OWN. Each file is linted by ESLint with the config that
 * governs it (its package's `eslint.config.js`) and only `max-lines` switched
 * on, its limit lowered to zero so the rule always reports, and the count is
 * read back from the rule's own message. So "lines" means exactly what the
 * rule means, and a source file the config exempts (`openapi-registry.ts`, the
 * Zod schema collections, `shared/ui`) is exempt here too. One deliberate
 * difference: `eslint-disable max-lines` comments are NOT honoured, because a
 * one-line comment would otherwise be the cheapest way out of the ratchet.
 * Those files are baselined like any other.
 *
 * WHAT FAILS (exit 1):
 *   - grew:      a baselined file is longer than its baseline;
 *   - new:       a file not in the baseline is over the limit;
 *   - stale:     a baselined source file shrank, dropped under the limit or is
 *                gone, and the baseline still says the old number (for test
 *                files, a note only: see below). Run `--update`,
 *                which only ever lowers or removes entries. Without this a
 *                file could shrink and later grow back to its old number.
 *   - raised:    with `--base <ref>`, an entry is higher than the base's, or
 *                is new and not a file git saw renamed from a base entry.
 *                The baseline is lowered (and carried across a rename) by
 *                `--update`, never raised by hand.
 *
 * TEST FILES HAVE THEIR OWN BASELINE (`TEST_BASELINE_PATH`). DOR-2822 left
 * them out and 627 grew past 500 by 2026-11-23. TypeScript tests (`.ts`,
 * `.tsx`) follow every rule above, counted the same way; `.mjs` tests are not
 * measured. Two differences. Every test is held whatever its config says
 * (`@dorkos/eslint-config/test` switches `max-lines` off); one in a path
 * ESLint ignores or has no config for is counted with the TypeScript parser
 * alone. And a stale test entry (shrank, split or deleted) is a note, not a
 * failure: many PRs split big tests at once, and each would otherwise go red
 * and conflict with the next on neighbouring baseline lines. `--update` locks
 * the shrinks in, in the weekly `pruning-tests` run by @dorkos-qa or by
 * anyone. The accepted gap: until it runs, a shrunk test may regrow up to its
 * old entry. A separate file because each entry is one line and git refuses
 * two edits on neighbouring lines: in one sorted list a test sits next to its
 * source file, so test splits would collide with source shrinks.
 *
 * Exit 2 means it could not run (no config, an unreadable baseline, a parse
 * failure): a gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:max-lines                      check against the baseline
 *   pnpm check:max-lines -- --base <ref>      also refuse a raised baseline
 *   pnpm check:max-lines -- --update          lower, remove, carry across renames
 *   pnpm check:max-lines -- --init            write the baseline from scratch
 *   pnpm check:max-lines -- --root <dir>      measure another tree (tests)
 *
 * @module scripts/check-max-lines
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

/** The limit the prefilter assumes. A file with fewer raw lines cannot be over it. */
export const LIMIT = 500;

/** Where the source files' baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/max-lines/baseline.json';

/** Where the test files' baseline lives, relative to the root. */
export const TEST_BASELINE_PATH = 'scripts/max-lines/test-baseline.json';

/**
 * Test files, held to {@link TEST_BASELINE_PATH}. Most packages switch
 * `max-lines` off for them through `@dorkos/eslint-config/test`; three configs
 * (`packages/cli`, `apps/e2e`, the repo root) never spread it, so the pattern
 * says once for all of them what a test file is, rather than trusting each
 * config's own idea of it.
 */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$|^apps\/e2e\/tests\//;

/** The same line breaks ESLint splits source text on. */
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;

/** The baseline file: each over-limit file and its count when last measured. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** Repo-relative path to `max-lines` count, sorted by path. */
  files: Record<string, number>;
}

/** What {@link measure} found: each over-limit file and its count, per baseline. */
export interface Counts {
  /** Source files, held to {@link BASELINE_PATH}. */
  source: Record<string, number>;
  /** Test files, held to {@link TEST_BASELINE_PATH}. */
  tests: Record<string, number>;
}

/** One reason the check fails. */
export interface Finding {
  /** Which rule of the ratchet was broken. */
  kind: 'grew' | 'new' | 'stale' | 'raised';
  /** The repo-relative file. */
  file: string;
  /** The file's count now, when it has one in scope. */
  count?: number;
  /** The number the baseline holds for it. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class MaxLinesError extends Error {}

/** Each baseline, by which files it holds, with the note written into it. */
const BASELINES = [
  {
    scope: 'source',
    path: BASELINE_PATH,
    staleFails: true,
    comment:
      'The 500-line ratchet (scripts/check-max-lines.ts, DOR-2822). Each file here was over the limit when measured. A file may shrink, never grow. Run `pnpm check:max-lines -- --update` after shrinking one; never raise a number by hand.',
  },
  {
    scope: 'tests',
    path: TEST_BASELINE_PATH,
    staleFails: false,
    comment:
      'The 500-line ratchet for test files (scripts/check-max-lines.ts). Each test file here was over the limit when measured. It may shrink, never grow: split it by subject, with shared setup in one fixtures module. New pieces under 500 need no entry. A shrink or deletion is only noted until `pnpm check:max-lines -- --update` locks it in; never raise a number by hand.',
  },
] as const satisfies readonly {
  scope: keyof Counts;
  path: string;
  /** Whether a stale entry fails the check or is only noted. */
  staleFails: boolean;
  comment: string;
}[];

/**
 * Measure every in-scope file over the limit.
 *
 * @param root - The tree to measure.
 * @returns Repo-relative path to its `max-lines` count, for files over their
 *   limit, split into source files and test files.
 */
export async function measure(root: string): Promise<Counts> {
  // Untracked files too, so a local run sees a file before it is added and
  // agrees with CI, which only ever has committed ones.
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  )
    .split('\0')
    .filter((file, i, all) => file && all.indexOf(file) === i);

  // Raw lines bound the counted ones from above, so reading text is enough to
  // rule out every file at or under the limit without parsing it.
  const candidates = tracked.filter((file) => {
    try {
      return readFileSync(join(root, file), 'utf8').split(LINE_BREAK).length > LIMIT;
    } catch {
      return false; // deleted in the working tree
    }
  });

  const eslint = new ESLint({ cwd: root });
  const inScope: string[] = [];
  const unlinted: string[] = []; // tests ESLint never lints, held all the same
  for (const file of candidates) {
    const abs = join(root, file);
    const test = TEST_FILE.test(file);
    let config: { rules?: Record<string, unknown> } | undefined;
    try {
      config = (await eslint.isPathIgnored(abs))
        ? undefined
        : await eslint.calculateConfigForFile(abs);
    } catch {
      config = undefined; // no config governs it, so ESLint never lints it
    }
    // Tests are held whatever their config says (it switches the rule off).
    if (test) (config ? inScope : unlinted).push(file);
    if (test || !config) continue;
    const rule = config?.rules?.['max-lines'];
    const entry = Array.isArray(rule) ? rule : [rule];
    if (entry[0] === 0 || entry[0] === 'off' || entry[0] === undefined) continue;
    const options = (entry[1] ?? {}) as Record<string, unknown>;
    // The counting pass below restates these options; refuse rather than
    // count a file differently from the rule that governs it.
    if (options.max !== LIMIT || options.skipBlankLines !== true || options.skipComments !== true) {
      throw new MaxLinesError(
        `${file}: max-lines options are ${JSON.stringify(options)}; this check assumes { max: ${LIMIT}, skipBlankLines: true, skipComments: true }.`
      );
    }
    inScope.push(file);
  }

  // The rule as the configs set it, with only the limit lowered so it reports
  // (and switched on for test files, whose config has it off).
  const counter = new ESLint({
    cwd: root,
    allowInlineConfig: false,
    ruleFilter: ({ ruleId }) => ruleId === 'max-lines',
    overrideConfig: {
      rules: { 'max-lines': ['warn', { max: 0, skipBlankLines: true, skipComments: true }] },
    },
  });
  const counts: Counts = { source: {}, tests: {} };
  const results = inScope.length ? await counter.lintFiles(inScope.map((f) => join(root, f))) : [];
  if (unlinted.length) {
    results.push(...(await bareCounter(root).lintFiles(unlinted.map((f) => join(root, f)))));
  }
  for (const result of results) {
    const file = result.filePath.slice(resolve(root).length + 1);
    const fatal = result.messages.find((m) => m.fatal);
    if (fatal) throw new MaxLinesError(`${file}: ESLint could not parse it (${fatal.message})`);
    const message = result.messages.find((m) => m.ruleId === 'max-lines');
    const count = Number(/\((\d+)\)/.exec(message?.message ?? '')?.[1]);
    if (!Number.isInteger(count)) throw new MaxLinesError(`${file}: no max-lines count reported`);
    if (count > LIMIT) counts[TEST_FILE.test(file) ? 'tests' : 'source'][file] = count;
  }
  return { source: sortKeys(counts.source), tests: sortKeys(counts.tests) };
}

/**
 * A counter that reads no config and ignores nothing, for test files no config
 * lints: the same rule and options, with the TypeScript parser every package
 * uses (taken from `@dorkos/eslint-config`, whose dependency it is).
 *
 * @param root - The tree to measure.
 */
function bareCounter(root: string): ESLint {
  let parser: unknown;
  try {
    const fromConfig = createRequire(
      new URL('../packages/eslint-config/package.json', import.meta.url)
    );
    parser = (fromConfig('typescript-eslint') as { parser: unknown }).parser;
  } catch {
    throw new MaxLinesError('cannot load typescript-eslint to count an unlinted test file');
  }
  return new ESLint({
    cwd: root,
    overrideConfigFile: true,
    ignore: false,
    allowInlineConfig: false,
    overrideConfig: {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: { parser: parser as never },
      rules: { 'max-lines': ['warn', { max: 0, skipBlankLines: true, skipComments: true }] },
    },
  });
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
 * Entries the baseline raised against its base. A new entry is allowed only
 * for a file git reports as renamed from a base entry, at no more than that
 * entry's number: moving a file is not a way to grow it, and a removed entry
 * buys nothing for an unrelated file.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 * @param renames - New path to old path, from {@link renamesSince}.
 */
export function raisedAgainst(
  current: Record<string, number>,
  base: Record<string, number>,
  renames: ReadonlyMap<string, string> = new Map()
): Finding[] {
  const findings: Finding[] = [];
  for (const [file, held] of Object.entries(current)) {
    const from = base[file] !== undefined ? file : renames.get(file);
    const before = from === undefined ? undefined : base[from];
    if (before === undefined) findings.push({ kind: 'raised', file, count: held });
    else if (held > before) findings.push({ kind: 'raised', file, count: held, baseline: before });
  }
  return findings;
}

/**
 * Files git sees as renamed between `ref` and the working tree, new path to old.
 *
 * @param root - The repository.
 * @param ref - The base commit.
 */
export function renamesSince(root: string, ref: string): Map<string, string> {
  const out = execFileSync('git', ['diff', '-M', '--name-status', '-z', '--diff-filter=R', ref], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\0');
  const renames = new Map<string, string>();
  // -z output: "R<score>", old path, new path, repeated.
  for (let i = 0; i + 2 < out.length; i += 3) {
    const [from, to] = [out[i + 1], out[i + 2]];
    if (from && to) renames.set(to, from);
  }
  return renames;
}

/**
 * The baseline after `--update`: every entry lowered to its count, entries no
 * longer over the limit removed, an entry carried to a renamed file's new path,
 * nothing raised and nothing else added.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's files.
 * @param renames - New path to old path, from {@link renamesSince}.
 * @param baseBaseline - The base's baseline. A renamed file's entry is taken
 *   from here when an earlier `--update` already dropped it from the working
 *   copy (a plain `mv` looks like a deletion until the new path is added).
 */
export function lowered(
  counts: Record<string, number>,
  baseline: Record<string, number>,
  renames: ReadonlyMap<string, string> = new Map(),
  baseBaseline: Record<string, number> = {}
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [file, held] of Object.entries(baseline)) {
    const count = counts[file];
    if (count !== undefined) next[file] = Math.min(held, count);
  }
  for (const [to, from] of renames) {
    const held = baseline[from] ?? baseBaseline[from];
    const count = counts[to];
    if (held !== undefined && count !== undefined && next[to] === undefined) {
      next[to] = Math.min(held, count);
    }
  }
  return sortKeys(next);
}

/** A stale test entry, which passes: what changed and how to lock it in. */
export function describeNote(f: Finding): string {
  const now = f.count === undefined ? 'gone or under the limit' : `down to ${f.count}`;
  return `${f.file}: ${now} (baseline ${f.baseline}); run \`pnpm check:max-lines -- --update\` to lock it in`;
}

/** One line a person can act on. */
export function describe(f: Finding): string {
  switch (f.kind) {
    case 'grew':
      return `${f.file}: grew to ${f.count} lines (baseline ${f.baseline}). Over-limit files may only shrink: move code out.`;
    case 'new':
      return `${f.file}: ${f.count} lines, over the ${LIMIT}-line limit. Split it before it lands${TEST_FILE.test(f.file) ? ', by subject, with shared setup in one fixtures module' : ''}. If you only moved a baselined file, run \`pnpm check:max-lines -- --update\` to carry its entry; a move between a test path and a source path carries nothing, so such a file must get under ${LIMIT}.`;
    case 'stale':
      return f.count === undefined
        ? `${f.file}: now under the limit or gone. Run \`pnpm check:max-lines -- --update\` to drop it from the baseline.`
        : `${f.file}: shrank to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:max-lines -- --update\` to lock that in.`;
    case 'raised':
      return f.baseline === undefined
        ? `${f.file}: added to the baseline at ${f.count}. The baseline is never added to by hand; split the file instead.`
        : `${f.file}: baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down; split the file instead.`;
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
    throw new MaxLinesError(`${where} is not valid JSON`);
  }
  const files = (parsed as Partial<Baseline>)?.files;
  if (!files || typeof files !== 'object') throw new MaxLinesError(`${where} has no files map`);
  for (const [file, n] of Object.entries(files)) {
    if (!Number.isInteger(n) || (n as number) <= LIMIT) {
      throw new MaxLinesError(`${where}: ${file} must be a whole number over ${LIMIT}`);
    }
  }
  return files as Record<string, number>;
}

function writeBaseline(
  root: string,
  { path, comment }: (typeof BASELINES)[number],
  files: Record<string, number>
): void {
  const body: Baseline = { $comment: comment, files };
  writeFileSync(join(root, path), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The baseline as it was at `ref`, or `null` when that tree had none. A ref
 * git cannot resolve is a failure to measure, never a skipped check.
 */
function baselineAt(root: string, ref: string, path: string): Record<string, number> | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new MaxLinesError(`--base ${ref} is not a commit this checkout has`);
  }
  let text: string;
  try {
    text = execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  return readBaseline(text, `${path} at ${ref}`);
}

/** Where this branch left `origin/main`, or undefined when that cannot be known. */
function mergeBase(root: string): string | undefined {
  try {
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = resolve(value('--root') ?? process.cwd());
  const counts = await measure(root);
  const tally = `${Object.keys(counts.source).length} source and ${Object.keys(counts.tests).length} test file(s)`;

  if (flag('--init')) {
    for (const held of BASELINES) writeBaseline(root, held, counts[held.scope]);
    console.log(`max-lines: wrote ${tally} to ${BASELINES.map((b) => b.path).join(' and ')}`);
    return 0;
  }

  // The base, for rename detection and the raise check. `--update` defaults
  // to where this branch left main, so a moved file keeps its entry.
  const base = value('--base') ?? (flag('--update') ? mergeBase(root) : undefined);
  const renames = base ? renamesSince(root, base) : new Map<string, string>();

  const problems: Finding[] = [];
  const notes: Finding[] = [];
  for (const held of BASELINES) {
    let text: string;
    try {
      text = readFileSync(join(root, held.path), 'utf8');
    } catch {
      throw new MaxLinesError(`cannot read ${held.path}`);
    }
    const baseline = readBaseline(text, held.path);
    const measured = counts[held.scope];

    if (flag('--update')) {
      const next = lowered(
        measured,
        baseline,
        renames,
        (base && baselineAt(root, base, held.path)) || {}
      );
      writeBaseline(root, held, next);
      console.log(`max-lines: ${held.path} holds ${Object.keys(next).length} file(s)`);
      // Lowering never fixes growth or a new file; say so rather than hide it.
      problems.push(...compare(measured, next).filter((f) => f.kind !== 'stale'));
      continue;
    }

    for (const f of compare(measured, baseline)) {
      if (f.kind === 'stale' && !held.staleFails) notes.push(f);
      else problems.push(f);
    }
    const before = base ? baselineAt(root, base, held.path) : null;
    if (before) problems.push(...raisedAgainst(baseline, before, renames));
  }

  if (notes.length) console.log(`max-lines: ${notes.length} note(s), not failures:`);
  for (const f of notes) console.log(`  ${describeNote(f)}`);
  if (problems.length === 0) {
    if (!flag('--update'))
      console.log(`max-lines: clean. ${tally} over ${LIMIT}, none grew, none new.`);
    return 0;
  }
  if (!flag('--update')) console.error(`max-lines: ${problems.length} problem(s):`);
  for (const f of problems) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`max-lines: cannot run: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  );
}
