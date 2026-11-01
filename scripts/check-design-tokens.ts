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
 *   - raised: with `--base <ref>`, an entry is higher than the base's;
 *   - rule:   with `--base <ref>`, a rule the base defined is gone, or its id,
 *             kind, pattern, only, except, files or count differs, and no
 *             fresh `guard-rule-change` label covers it (DOR-3557). What the
 *             label does and does not prove is in design-tokens/rule-guard.ts.
 *
 * THIS FILE IMPORTS NOTHING RELATIVE, at the top level. The rule guard reads a
 * base's rules by importing the base's copy of this file alone, from a scratch
 * directory; a relative import would fail there, and the guard would refuse.
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

/** This file, relative to the root: where the base's rules are read from. */
export const SCRIPT_PATH = 'scripts/check-design-tokens.ts';

/** The PR label that lets a PR remove or change a rule the base defined. */
export const OVERRIDE_LABEL = 'guard-rule-change';

/** The trees the rules cover. */
const SCOPES = ['apps/client/src', 'packages/ui/src'];

/** Tests and the dev playground may spell anything. */
const EXEMPT = /(^|\/)__tests__\/|\.(test|spec)\.tsx?$|^apps\/client\/src\/dev\//;

/** The file types the gate reads at all. */
const MEASURED = /\.(tsx?|css)$/;

/** The file types a rule reads when it names none. */
const DEFAULT_FILES = /\.tsx?$/;

/** What every rule reads, compared like a rule: narrowing it loosens all of them. */
export const COVERAGE = {
  scopes: SCOPES,
  exempt: EXEMPT,
  measured: MEASURED,
  files: DEFAULT_FILES,
};

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

/** The folders a room's timeline rows are drawn from (ROOMS-SPEC §11, guard rows). */
const ROOM_ROWS =
  /^apps\/client\/src\/layers\/(?:widgets\/room-view|features\/entry-actions|features\/conversation\/ui\/rows)\//;

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
  /** Skips paths this matches: the one file allowed to spell the pattern. */
  except?: RegExp;
  /** The file types the rule reads. Defaults to TypeScript and TSX. */
  files?: RegExp;
  /** Counts matches in a file's text when a regex alone cannot. Replaces `pattern`. */
  count?: (text: string) => number;
  /** What to write instead. */
  fix: string;
}

/** Remove CSS comments, so a comment that names a curve is not that curve. */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Whether a `cubic-bezier(x1, y1, x2, y2)` leaves 0..1 on the y axis, so overshoots. */
function overshoots(args: string): boolean {
  const [, y1 = 0, , y2 = 0] = args.split(',').map(Number);
  return y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1;
}

/**
 * The one line `overshoot-bezier` skips: `animation: reaction-pop <time>
 * cubic-bezier(…);`, alone on its line, where the time is a number or one
 * `var(--…)`. A selector, a second animation or a custom property beside it is
 * not this line, so it is read.
 */
const REACTION_POP =
  /^\s*animation:\s*reaction-pop\s+(?:var\(--[\w-]+\)|[\d.]+m?s)\s+cubic-bezier\([^()]*\)\s*;?\s*$/;

/**
 * What a rule's `count` calls besides itself. Its source is compared with the
 * rule's, so loosening a helper is a rule change too. A helper missing from
 * this list could change unseen, so a test fails when a `count` calls a
 * function or names a constant that is not here.
 */
export const RULE_HELPERS: Record<string, unknown> = {
  stripCssComments,
  overshoots,
  REACTION_POP,
};

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
  // Phase 2 Badge A. A count has one cap per placement, spelled in count-pill.
  {
    id: 'local-count-cap',
    kind: 'hard',
    pattern: /\b(?:DISPLAY_CAP|MAX_COUNT)\b|\bconst\s+COUNT_PILL_CAP\b/g,
    except: /^apps\/client\/src\/layers\/shared\/ui\/count-pill\.tsx$/,
    fix: 'use CountPill and its cap prop, or COUNT_PILL_CAP / CORNER_COUNT_CAP / MENTION_COUNT_CAP',
  },
  {
    id: 'hand-rolled-count',
    kind: 'hard',
    pattern: /^(?=.*\btabular-nums\b)(?=.*\brounded-full\b).*$/gm,
    except:
      /^apps\/client\/src\/layers\/(?:shared\/ui\/(?:count-pill|badge)\.tsx|features\/chat\/ui\/chips\/TouchChip\.tsx)$/,
    fix: 'use CountPill for a number, Badge for a label',
  },
  {
    id: 'count-flip',
    kind: 'hard',
    pattern: /\banimate-count-flip\b/g,
    except: /^apps\/client\/src\/layers\/features\/conversation\/ui\/rows\/ThreadReplyRow\.tsx$/,
    fix: "a count changes instantly; the flip is ThreadReplyRow's alone",
  },
  // Phase 2, cards and rows (CARD-ROW-SPEC §10, rows 1 to 4).
  {
    id: 'shared-divide-y',
    kind: 'hard',
    pattern: /(?<![\w-])divide-y\b/g,
    only: /^apps\/client\/src\/layers\/shared\/ui\//,
    except: /\/table\.tsx$/,
    fix: 'separate rows with space (FieldCardContent pays px-4 py-3)',
  },
  {
    id: 'field-card-border',
    kind: 'hard',
    pattern: /<FieldCard\b[^>]*className=[^>]*(?<![\w-])border(?:-[\w/]+)?\b/g,
    fix: 'a group has no border; the heading and the button carry danger',
  },
  {
    id: 'card-border',
    kind: 'hard',
    pattern: /'bg-(?:card|row-group)\b[^']*(?<![\w-])border\b/g,
    only: /^apps\/client\/src\/layers\/shared\/ui\/(?:card|field-card)\.tsx$/,
    fix: 'a card is a surface and a soft lift, nothing else',
  },
  {
    id: 'row-ring-mark',
    kind: 'hard',
    pattern: /\b(?:isSelected|isFocused|selected) && '[^']*\bring-2\b/g,
    except: /^apps\/client\/src\/layers\/features\/mesh\/ui\//,
    fix: 'use rowStateVariants: bg-row-selected, and the inset outline for focus',
  },
  // Phase 4 rooms A (ROOMS-SPEC §11): the timeline rows a room draws.
  {
    id: 'room-warning-text',
    kind: 'hard',
    pattern: /\btext-status-warning(?![\w-])/g,
    only: ROOM_ROWS,
    fix: 'amber goes on the glyph: text-status-warning-fg; the words stay text-foreground',
  },
  {
    id: 'reaction-ring',
    kind: 'hard',
    pattern: /\banimate-reaction-ring\b/g,
    fix: 'a reaction gets one celebration, the pop',
  },
  {
    id: 'room-italic',
    kind: 'hard',
    pattern: /['"`][^'"`\n]*(?<![\w-])italic(?![\w-])[^'"`\n]*['"`]/g,
    only: ROOM_ROWS,
    fix: 'the room speaks in one voice: text-xs text-muted-foreground, no italic',
  },
  {
    id: 'reaction-pill-border',
    kind: 'hard',
    pattern: /['"`][^'"`\n]*(?<![\w:-])border(?:-[a-z]+(?:\/\d+)?)?(?![\w-])[^'"`\n]*['"`]/g,
    only: /^apps\/client\/src\/layers\/features\/entry-actions\/ui\/EntryReactionRow\.tsx$/,
    fix: 'a reaction pill is a tint: bg-foreground/5, or bg-brand/15 for yours',
  },
  // Phase 1 motion. One set of springs and curves, none of which overshoots.
  {
    id: 'spring-literal',
    kind: 'ratchet',
    pattern: /\bstiffness:/g,
    files: /\.(tsx?|css)$/,
    except: /^apps\/client\/src\/layers\/shared\/lib\/motion\.ts$/,
    fix: 'use SPRING from shared/lib/motion.ts',
  },
  {
    id: 'overshoot-bezier',
    kind: 'hard',
    pattern: /(?!)/g,
    only: /^apps\/client\/src\/index\.css$/,
    files: /\.css$/,
    // `reaction-pop` is the one overshoot a reaction gets (spec D6): exactly its
    // `animation:` declaration, alone on its line.
    count: (text) =>
      stripCssComments(text)
        .split('\n')
        .filter((line) => !REACTION_POP.test(line))
        .flatMap((line) => [...line.matchAll(/cubic-bezier\(([^)]+)\)/g)])
        .filter((match) => overshoots(match[1] ?? '')).length,
    fix: 'use var(--ease-out), var(--ease-in) or var(--ease-standard)',
  },
];

/** The baseline: rule id to repo-relative path to count. */
export type Counts = Record<string, Record<string, number>>;

/** One reason the check fails. */
export interface Finding {
  /** Which part of the gate was broken. */
  kind: 'hard' | 'grew' | 'stale' | 'raised' | 'rule';
  /** The rule involved. */
  rule: string;
  /** The repo-relative file. */
  file: string;
  /** The count now. */
  count: number;
  /** The number the baseline holds. */
  baseline?: number;
  /** For `rule`: what changed, and why no label covers it. */
  detail?: string;
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
    if (rule.except?.test(file)) continue;
    if (!(rule.files ?? DEFAULT_FILES).test(file)) continue;
    const n = rule.count ? rule.count(text) : (text.match(rule.pattern)?.length ?? 0);
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
    .filter((f, i, all) => MEASURED.test(f) && !EXEMPT.test(f) && all.indexOf(f) === i);

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
 * Which rules may seed a first baseline: the ratchets whose id the base never
 * defined. None may, when a rule the base defined is gone from this tree, so a
 * rename cannot reset a count by starting a new rule at its own number.
 *
 * @param rules - The rules on this tree.
 * @param baseIds - The rule ids the base defined, or null when they are unknown.
 */
export function seedableRules(rules: Rule[], baseIds: string[] | null): Set<string> {
  if (!baseIds) return new Set();
  if (baseIds.some((id) => !rules.some((r) => r.id === id))) return new Set();
  return new Set(
    rules.filter((r) => r.kind === 'ratchet' && !baseIds.includes(r.id)).map((r) => r.id)
  );
}

/**
 * Entries the baseline raised against its base.
 *
 * A rule in `seedable` has no base entries to raise, so its first baseline is
 * held to what the check measures here: a number above it is a raise.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 * @param seedable - Rules that may seed a first baseline, from {@link seedableRules}.
 * @param counts - What {@link measure} found on this tree, to check a seed against.
 */
export function raisedAgainst(
  current: Counts,
  base: Counts,
  seedable: ReadonlySet<string> = new Set(),
  counts: Counts = {}
): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, files] of Object.entries(current)) {
    const seeding = seedable.has(rule) && !(rule in base);
    for (const [file, count] of Object.entries(files)) {
      const before = seeding ? (counts[rule]?.[file] ?? 0) : (base[rule]?.[file] ?? 0);
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
    case 'rule':
      return `${f.file}: ${f.detail}.`;
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

async function main(argv: string[]): Promise<number> {
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
  if (base) {
    const before = baselineAt(root, base);
    // Loaded here, never at the top: see "imports nothing relative" above.
    const { checkRules } = await import('./design-tokens/rule-guard.ts');
    const rules = await checkRules(root, base);
    findings.push(...rules.findings);
    if (before) {
      const seedable = seedableRules(RULES, rules.baseIds);
      findings.push(...raisedAgainst(baseline, before, seedable, counts));
    }
  }

  if (findings.length === 0) {
    console.log('design-tokens: clean.');
    return 0;
  }
  console.error(`design-tokens: ${findings.length} problem(s):`);
  for (const f of findings) console.error(`  ${describe(f)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A promise, not a top-level await: the rule guard imports this module, and
  // a module still in its top-level await would never finish loading for it.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(
        `design-tokens: cannot run: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(2);
    }
  );
}
