/**
 * Hold the client and the shared UI package to the design tokens.
 *
 * WHY THIS EXISTS. Phase 1 of the UI overhaul turned colours, scrims and the
 * stacking order into tokens. A token only stays the one way to say something
 * if a new literal cannot land beside it, and some of the old spellings are in
 * hundreds of places a token PR must not restyle. So there are two kinds of rule:
 *
 *   - hard:    none may exist. Fails on any match.
 *   - ratchet: today's count per file is the baseline. A count may fall, never
 *              rise, and a new file starts at zero.
 *
 * WHAT FAILS (exit 1):
 *   - hard:   a match of a hard rule;
 *   - grew:   a file holds more of a ratcheted pattern than its baseline;
 *   - stale:  a count fell and the baseline still says the old number. Run
 *             `--update`, which only lowers or removes;
 *   - raised: with `--base <ref>`, an entry is higher than the base's.
 *
 * Exit 2 means it could not run: a gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:design-tokens                   check against the baseline
 *   pnpm check:design-tokens -- --base <ref>   also refuse a raised baseline
 *   pnpm check:design-tokens -- --update       lower and remove entries
 *   pnpm check:design-tokens -- --init         write the baseline from scratch
 *   pnpm check:design-tokens -- --root <dir>   measure another tree (tests)
 *
 * @module scripts/check-design-tokens
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/design-tokens/baseline.json';

/** The trees the rules cover. */
const SCOPES = ['apps/client/src', 'packages/ui/src'];

/** Tests and the dev playground may spell anything. */
const EXEMPT = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$|^apps\/client\/src\/dev\//;

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

/** One pattern the gate counts. */
export interface Rule {
  /** The name a failure and the baseline use. */
  id: string;
  /** `hard` fails on any match; `ratchet` fails when a file's count rises. */
  kind: 'hard' | 'ratchet';
  /** What to match, with the `g` flag. */
  pattern: RegExp;
  /** Limits the rule to paths this matches. */
  only?: RegExp;
  /** What to write instead. */
  fix: string;
}

/** Every rule. A later phase adds its own patterns here. */
export const RULES: Rule[] = [
  {
    id: 'black-scrim',
    kind: 'hard',
    pattern: /\bbg-black\/\d+/g,
    fix: 'use bg-scrim (bg-dui-scrim in packages/ui)',
  },
  {
    id: 'literal-z-index',
    kind: 'hard',
    pattern: /(?<![\w-])z-(?:50|\[[^\]]+\])/g,
    only: /^packages\/ui\/src\//,
    fix: 'use a z-(--z-*) token',
  },
  {
    id: 'raw-palette',
    kind: 'ratchet',
    pattern: new RegExp(
      `(?<![\\w-])(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder)-(?:${PALETTE})-\\d{2,3}\\b`,
      'g'
    ),
    fix: 'use a semantic token',
  },
  {
    id: 'pure-white-black',
    kind: 'ratchet',
    pattern: /\bbg-white\/\d+|(?<![\w-])text-white(?![\w-])|#(?:fff|000)(?:fff|000)?\b/gi,
    fix: 'use a semantic token',
  },
  {
    id: 'stray-focus-ring',
    kind: 'ratchet',
    pattern: /\bfocus-visible:ring-/g,
    fix: 'use the focus-ring recipe',
  },
];

/** The baseline: rule id to repo-relative path to count. */
export type Counts = Record<string, Record<string, number>>;

/** One reason the check fails. */
export interface Finding {
  /** Which part of the gate was broken. */
  kind: 'hard' | 'grew' | 'stale' | 'raised';
  /** The rule involved. */
  rule: string;
  /** The repo-relative file. */
  file: string;
  /** The count now. */
  count: number;
  /** The number the baseline holds. */
  baseline?: number;
}

/** A thrown failure that means "could not measure", exit 2. */
export class DesignTokensError extends Error {}

/**
 * Count every rule in one file's text.
 *
 * @param file - The repo-relative path, for rules limited to some paths.
 * @param text - The file's source.
 * @param rules - The rules to count.
 * @returns Rule id to count, for rules that matched.
 */
export function countIn(file: string, text: string, rules: Rule[] = RULES): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rule of rules) {
    if (rule.only && !rule.only.test(file)) continue;
    const n = text.match(rule.pattern)?.length ?? 0;
    if (n > 0) out[rule.id] = n;
  }
  return out;
}

/**
 * Measure a tree.
 *
 * @param root - The tree to measure.
 * @returns What every rule matched, hard rules included.
 */
export function measure(root: string): Counts {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCOPES],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((f, i, all) => /\.tsx?$/.test(f) && !EXEMPT.test(f) && all.indexOf(f) === i);

  const counts: Counts = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    for (const [rule, n] of Object.entries(countIn(file, text))) {
      (counts[rule] ??= {})[file] = n;
    }
  }
  return sorted(counts);
}

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline.
 * @param rules - The rules the counts came from.
 */
export function compare(counts: Counts, baseline: Counts, rules: Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  for (const { id: rule, kind } of rules) {
    const now = counts[rule] ?? {};
    if (kind === 'hard') {
      for (const [file, count] of Object.entries(now)) {
        findings.push({ kind: 'hard', rule, file, count });
      }
      continue;
    }
    const held = baseline[rule] ?? {};
    for (const [file, count] of Object.entries(now)) {
      const before = held[file] ?? 0;
      if (count > before) findings.push({ kind: 'grew', rule, file, count, baseline: before });
      else if (count < before)
        findings.push({ kind: 'stale', rule, file, count, baseline: before });
    }
    for (const [file, before] of Object.entries(held)) {
      if (!(file in now)) findings.push({ kind: 'stale', rule, file, count: 0, baseline: before });
    }
  }
  return findings;
}

/**
 * Entries the baseline raised against its base.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(current: Counts, base: Counts): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, files] of Object.entries(current)) {
    for (const [file, count] of Object.entries(files)) {
      const before = base[rule]?.[file] ?? 0;
      if (count > before) findings.push({ kind: 'raised', rule, file, count, baseline: before });
    }
  }
  return findings;
}

/**
 * The baseline after `--update`: entries lowered or removed, nothing raised.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline.
 */
export function lowered(counts: Counts, baseline: Counts): Counts {
  const next: Counts = {};
  for (const [rule, files] of Object.entries(baseline)) {
    for (const [file, held] of Object.entries(files)) {
      const count = counts[rule]?.[file];
      if (count) (next[rule] ??= {})[file] = Math.min(held, count);
    }
  }
  return sorted(next);
}

/** One line a person can act on. */
export function describe(f: Finding, rules: Rule[] = RULES): string {
  const fix = rules.find((r) => r.id === f.rule)?.fix ?? '';
  switch (f.kind) {
    case 'hard':
      return `${f.file}: ${f.count} of ${f.rule}, which may not exist: ${fix}.`;
    case 'grew':
      return `${f.file}: ${f.rule} rose to ${f.count} (baseline ${f.baseline}): ${fix}.`;
    case 'stale':
      return `${f.file}: ${f.rule} fell to ${f.count} (baseline ${f.baseline}). Run \`pnpm check:design-tokens -- --update\` to lock that in.`;
    case 'raised':
      return `${f.file}: ${f.rule} baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
  }
}

function sorted(counts: Counts): Counts {
  const entries = (o: Record<string, number>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, files]) => [rule, entries(files)])
  );
}

function ratcheted(counts: Counts): Counts {
  const ids = new Set(RULES.filter((r) => r.kind === 'ratchet').map((r) => r.id));
  return Object.fromEntries(Object.entries(counts).filter(([rule]) => ids.has(rule)));
}

function parseBaseline(text: string, where: string): Counts {
  try {
    const rules = (JSON.parse(text) as { rules?: Counts }).rules;
    if (rules && typeof rules === 'object') return rules;
  } catch {
    // Falls through to the same failure as a file with no rules map.
  }
  throw new DesignTokensError(`${where} has no readable rules map`);
}

function writeBaseline(root: string, rules: Counts): void {
  const $comment =
    'The design-token ratchet (scripts/check-design-tokens.ts). A count may fall, never rise. Run `pnpm check:design-tokens -- --update` after lowering one; never raise a number by hand.';
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify({ $comment, rules }, null, 2)}\n`);
}

function baselineAt(root: string, ref: string): Counts | null {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new DesignTokensError(`--base ${ref} is not a commit this checkout has`);
  }
  try {
    const text = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseBaseline(text, `${BASELINE_PATH} at ${ref}`);
  } catch (err) {
    if (err instanceof DesignTokensError) throw err;
    return null; // the base has no baseline yet
  }
}

function main(argv: string[]): number {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = resolve(value('--root') ?? process.cwd());
  const counts = measure(root);

  if (argv.includes('--init')) {
    writeBaseline(root, ratcheted(counts));
    console.log(`design-tokens: wrote ${BASELINE_PATH}`);
    return 0;
  }

  let text: string;
  try {
    text = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new DesignTokensError(`cannot read ${BASELINE_PATH}`);
  }
  const baseline = parseBaseline(text, BASELINE_PATH);

  if (argv.includes('--update')) {
    const next = lowered(counts, baseline);
    writeBaseline(root, next);
    const left = compare(counts, next).filter((f) => f.kind !== 'stale');
    for (const f of left) console.error(`  ${describe(f)}`);
    return left.length ? 1 : 0;
  }

  const findings = compare(counts, baseline);
  const base = value('--base');
  const before = base ? baselineAt(root, base) : null;
  if (before) findings.push(...raisedAgainst(baseline, before));

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
