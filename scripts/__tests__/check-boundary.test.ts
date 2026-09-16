/**
 * Pin suite for `check-boundary.ts`, the DOR-2024 boundary guard.
 *
 * WHY THIS EXISTS, AND WHAT IT IS ACTUALLY FOR. The guard's whole value rests
 * on one property that no ordinary test exercises: it must never print the
 * text it matched, because it runs in a public repository whose Actions logs
 * are world-readable, and the one event it exists for is a private term
 * reaching public source. A guard that printed the match would publish that
 * term more durably than the paste it caught. So the centrepiece here is not
 * "does it catch things" — it is {@link https://linear.app/ DOR-2024}'s
 * no-leak property: seed an invented term, run the real CLI end to end,
 * capture ALL of stdout and stderr, and fail if the term appears anywhere.
 * The leak lives on the error path (a pattern that does not compile is
 * reported by the regex engine by QUOTING THE PATTERN), so the error path is
 * tested as deliberately as the happy one.
 *
 * THIS SUITE SEEDS ITS OWN INVENTED TERMS AND NEVER READS THE REAL LIST — not
 * even to check itself. A private term copied into a test fixture travels with
 * every future copy of these scripts, which is the leak the whole scheme
 * exists to prevent. The "no real rule appears in a fixture" assertion cannot
 * live here; it belongs in the job, where the private ruleset is available,
 * and it is the guard's own real-repo run that provides it.
 *
 * Fixtures are synthetic strings passed straight to the exported functions, or
 * a throwaway temp directory — the hermetic pattern `check-vocab-gate.test.ts`
 * uses — plus one real-repo canary, so a red here is this guard and not an
 * unrelated PR's new file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundaryError,
  SHAPE_RULE_NOTES,
  buildRuleset,
  collectFiles,
  isAllowlisted,
  loadAllowlist,
  loadShapeRules,
  parseRuleset,
  runBoundaryGuard,
  scanText,
  validateAllowlist,
  type AllowlistEntry,
} from '../check-boundary.ts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const GUARD = join(SCRIPTS_DIR, 'check-boundary.ts');

/**
 * An invented term with no relationship to anything real, used everywhere this
 * suite needs "a private term". Deliberately unpronounceable so that a future
 * reader cannot mistake it for a redacted real one.
 */
const FAKE_TERM = 'zorblax';

/** A tier-2-shaped ruleset built from {@link FAKE_TERM}. */
const FAKE_RULESET = `# invented, for tests only\nBND-901\t${FAKE_TERM}\n`;

const tempDirs: string[] = [];

/** A fresh temp directory, tracked for cleanup after the test. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-boundary-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Write `content` to `rel` under `root`, creating directories as needed. */
function seedFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Run the guard's CLI exactly as CI does, capturing everything it printed.
 *
 * @param root - Tree to scan.
 * @param env - Extra environment on top of a cleaned copy of this process's.
 */
function runCli(
  root: string,
  env: Record<string, string> = {}
): { status: number; output: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', GUARD, root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      BOUNDARY_TERMS: '',
      BOUNDARY_REQUIRE_TERMS: '',
      ...env,
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The property the whole design turns on: no matched text is ever printed
// ---------------------------------------------------------------------------

describe('the guard never prints a term from the private ruleset', () => {
  /**
   * The four shapes a real paste arrives in. A pattern that has lost its
   * tolerance for one of them still passes a single plain-match test, so they
   * are four cases and not one.
   */
  const SHAPES: [name: string, line: string][] = [
    ['plain', `see ${FAKE_TERM}`],
    ['possessive', `${FAKE_TERM}'s dashboard`],
    ['hyphenated', `the ${FAKE_TERM}-broker endpoint`],
    ['mid-sentence', `we route through ${FAKE_TERM} before billing`],
  ];

  for (const [shape, line] of SHAPES) {
    it(`catches the ${shape} shape and prints file, line and rule id only`, () => {
      const root = makeTempDir();
      seedFile(root, 'docs/notes.md', `# Notes\n\n${line}\n`);

      const { status, output } = runCli(root, { BOUNDARY_TERMS: FAKE_RULESET });

      expect(status).toBe(1);
      expect(output).toContain('docs/notes.md:3  BND-901');
      expect(output).not.toContain(FAKE_TERM);
    });
  }

  it('prints exactly one mode line, and that line carries no term', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/clean.md', '# Nothing to see\n');

    const { output } = runCli(root, { BOUNDARY_TERMS: FAKE_RULESET });
    const modeLines = output.split('\n').filter((l) => l.startsWith('boundary: mode='));

    expect(modeLines).toHaveLength(1);
    expect(modeLines[0]).toBe('boundary: mode=shape+terms — private ruleset loaded (1 rule)');
    expect(modeLines[0]).not.toContain(FAKE_TERM);
  });

  it('does not describe a private rule id in the legend — a description is a description of a term', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/notes.md', `${FAKE_TERM}\n`);

    const { output } = runCli(root, { BOUNDARY_TERMS: FAKE_RULESET });

    expect(output).toContain('BND-901');
    // The legend's shape is a line that STARTS with the id and continues; a
    // finding's shape is a line that ends with it. Only the latter may appear.
    const legendLines = output.split('\n').filter((l) => /^\s*BND-901\s+\S/.test(l));
    expect(legendLines).toEqual([]);
  });

  it('a pattern that does not compile is reported by rule id, never by pattern', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/clean.md', 'nothing\n');
    // `[` opens a character class that is never closed; the regex engine's own
    // SyntaxError quotes the offending pattern back at the caller.
    const pattern = `[${FAKE_TERM}`;

    const { status, output } = runCli(root, { BOUNDARY_TERMS: `BND-902\t${pattern}\n` });

    expect(status).toBe(2);
    expect(output).toContain('BND-902');
    expect(output).not.toContain(FAKE_TERM);
  });

  it('a malformed ruleset line is reported by line number, never by line', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/clean.md', 'nothing\n');

    const { status, output } = runCli(root, {
      BOUNDARY_TERMS: `# header\n${FAKE_TERM} with no tab\n`,
    });

    expect(status).toBe(2);
    expect(output).toContain('line 2');
    expect(output).not.toContain(FAKE_TERM);
  });

  it('a Finding carries no snippet, match or column that could be printed later', () => {
    const rules = parseRuleset(FAKE_RULESET, 'private', 'test');
    const findings = scanText('docs/notes.md', `a ${FAKE_TERM} b\n`, rules);

    expect(findings).toHaveLength(1);
    expect(Object.keys(findings[0]!).sort()).toEqual(['file', 'line', 'ruleId']);
    expect(JSON.stringify(findings)).not.toContain(FAKE_TERM);
  });
});

// ---------------------------------------------------------------------------
// Modes: generic mode is entered on purpose, never as a fallback
// ---------------------------------------------------------------------------

describe('mode selection', () => {
  const SHAPE = parseRuleset('BND-201\tnothing-real\n', 'shape', 'test');

  it('no private ruleset and none expected: shape-only, said out loud', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/clean.md', 'nothing\n');

    const { status, output } = runCli(root);

    expect(status).toBe(0);
    expect(output).toContain('boundary: mode=shape-only — generic mode, shape patterns only');
  });

  it('a private ruleset present: shape+terms, with the rule count', () => {
    const built = buildRuleset({ BOUNDARY_TERMS: FAKE_RULESET }, SHAPE);

    expect(built.mode).toBe('shape+terms');
    expect(built.privateRuleCount).toBe(1);
    expect(built.rules).toHaveLength(2);
  });

  it('expected but absent is a hard failure, not a quiet downgrade', () => {
    expect(() => buildRuleset({ BOUNDARY_REQUIRE_TERMS: '1' }, SHAPE)).toThrow(BoundaryError);
  });

  it('expected but empty — the renamed-secret case — is a hard failure', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/clean.md', 'nothing\n');

    const { status, output } = runCli(root, { BOUNDARY_REQUIRE_TERMS: '1', BOUNDARY_TERMS: '' });

    expect(status).toBe(2);
    expect(output).toContain('cannot run');
    expect(output).not.toContain('mode=shape-only');
  });

  it('present but all comments and blanks parses to zero rules and fails', () => {
    expect(() => buildRuleset({ BOUNDARY_TERMS: '# a\n\n   \n' }, SHAPE)).toThrow(BoundaryError);
  });

  it('a rule id defined in both tiers is a hard failure — an id means one thing', () => {
    expect(() => buildRuleset({ BOUNDARY_TERMS: 'BND-201\tanything\n' }, SHAPE)).toThrow(
      BoundaryError
    );
  });
});

// ---------------------------------------------------------------------------
// The shared wire format
// ---------------------------------------------------------------------------

describe('parseRuleset — the format both tiers share', () => {
  it('reads one rule per line as <rule-id> TAB <regex>', () => {
    const rules = parseRuleset('BND-301\tfoo\nBND-302\tbar\n', 'shape', 'test');

    expect(rules.map((r) => r.id)).toEqual(['BND-301', 'BND-302']);
    expect(rules.every((r) => r.tier === 'shape')).toBe(true);
  });

  it('ignores comments, blank lines and indented comments', () => {
    expect(parseRuleset('# a\n\n  # b\nBND-301\tfoo\n', 'shape', 'test')).toHaveLength(1);
  });

  it('scans the last line of a body with no trailing newline', () => {
    expect(parseRuleset('BND-301\tfoo', 'shape', 'test')).toHaveLength(1);
  });

  it('has no third column: a second tab belongs to the pattern', () => {
    const [rule] = parseRuleset('BND-301\ta\tb\n', 'shape', 'test');

    expect(rule!.pattern.test('a\tb')).toBe(true);
  });

  it('tolerates CRLF, which is how a secret pasted from Windows arrives', () => {
    expect(parseRuleset('BND-301\tfoo\r\n', 'shape', 'test')).toHaveLength(1);
  });

  it('rejects a duplicate rule id', () => {
    expect(() => parseRuleset('BND-301\ta\nBND-301\tb\n', 'shape', 'test')).toThrow(BoundaryError);
  });

  it('rejects a malformed rule id', () => {
    expect(() => parseRuleset('not an id\tfoo\n', 'shape', 'test')).toThrow(BoundaryError);
  });

  it('rejects a line with a tab but no pattern', () => {
    expect(() => parseRuleset('BND-301\t\n', 'shape', 'test')).toThrow(BoundaryError);
  });

  it('matches case-insensitively, because a paste does not preserve case', () => {
    const [rule] = parseRuleset('BND-301\tfoo\n', 'shape', 'test');

    expect(rule!.pattern.test('FOO')).toBe(true);
  });

  it('compiles without the g flag, so a rule cannot go stateful across lines', () => {
    const [rule] = parseRuleset('BND-301\tfoo\n', 'shape', 'test');

    expect(rule!.pattern.global).toBe(false);
    expect(rule!.pattern.test('foo')).toBe(true);
    expect(rule!.pattern.test('foo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The committed tier-1 patterns
// ---------------------------------------------------------------------------

describe('shape rules — each catches a planted example', () => {
  const rules = loadShapeRules();

  /**
   * The compiled pattern for one rule id, so a planted example is tested
   * against the rule it is planted for and not against the whole ruleset.
   *
   * @param id - Rule id, as spelled in `shape-rules.tsv`.
   */
  function rule(id: string) {
    const found = rules.find((r) => r.id === id);
    expect(found, `${id} is missing from shape-rules.tsv`).toBeDefined();
    return found!.pattern;
  }

  it('BND-201 catches an internal-facing host under a real registrable domain', () => {
    expect(rule('BND-201').test('https://internal.acmecorp.io/v1/seats')).toBe(true);
    expect(rule('BND-201').test('billing.acmecorp.com')).toBe(true);
    expect(rule('BND-201').test('broker.acmecorp.dev:443')).toBe(true);
  });

  it('BND-201 catches a three-label host, which is the normal control-plane shape', () => {
    expect(rule('BND-201').test('https://billing.internal.acmecorp.cloud/v1')).toBe(true);
  });

  it('BND-201 leaves ordinary public hosts and dotted filenames alone', () => {
    expect(rule('BND-201').test('https://dorkos.ai/pricing')).toBe(false);
    expect(rule('BND-201').test("import x from './admin.test.ts';")).toBe(false);
    expect(rule('BND-201').test('const opsTestTs = 1;')).toBe(false);
  });

  it('BND-301 catches a price followed by a plan-shaped word', () => {
    expect(rule('BND-301').test('the Crew plan is $19 per seat')).toBe(true);
    expect(rule('BND-301').test('$29/mo')).toBe(true);
    expect(rule('BND-301').test('$12 per month')).toBe(true);
  });

  it('BND-301 does not fire on a plan word merely containing "tier"', () => {
    expect(rule('BND-301').test('`$0` becomes the fixture path, so prettier rewrites it')).toBe(
      false
    );
  });

  it('BND-302 catches a plan-shaped word followed by a price', () => {
    expect(rule('BND-302').test('the paid tier starts at $49')).toBe(true);
    expect(rule('BND-302').test('per-seat pricing is $9')).toBe(true);
  });

  it('BND-302 does not fire when the plan word is inside another word', () => {
    expect(rule('BND-302').test('prettier costs $0 because it is free')).toBe(false);
  });

  it('BND-301 and BND-302 understand currencies other than the dollar sign', () => {
    expect(rule('BND-301').test('€49 per seat')).toBe(true);
    expect(rule('BND-301').test('19 USD per seat')).toBe(true);
    expect(rule('BND-302').test('the Crew plan is 19 USD')).toBe(true);
    expect(rule('BND-302').test('the paid tier starts at €49')).toBe(true);
    expect(rule('BND-302').test('per-seat pricing is £9')).toBe(true);
  });

  it('BND-303 catches a margin, the third category AGENTS.md names', () => {
    expect(rule('BND-303').test('gross margin on the Scale plan is 62%')).toBe(true);
    expect(rule('BND-303').test('blended margins of 41 percent')).toBe(true);
  });

  it('BND-303 does not fire on a CSS margin, which is what "margin" usually means here', () => {
    expect(rule('BND-303').test('the card keeps a margin of 16% on narrow screens')).toBe(false);
    expect(rule('BND-303').test('margin-inline: 4%;')).toBe(false);
  });

  it("the real AGENTS.md '## DorkOS Cloud' paragraph passes", () => {
    // The REAL paragraph, read from the file, not a paraphrase of it — an
    // assertion about a fabricated subject proves nothing about the subject.
    const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    const section = agents.slice(agents.indexOf('## DorkOS Cloud'));
    const paragraph = section.slice(0, section.indexOf('\n## ', 1));
    expect(paragraph).toContain('plan names');

    const allowlist = loadAllowlist();
    const unallowed = scanText('AGENTS.md', paragraph, rules).filter(
      (f) => !isAllowlisted(f.file, f.ruleId, allowlist)
    );

    expect(unallowed).toEqual([]);
  });

  it('the seeded allowlist keeps that paragraph passing even if it quotes an amount', () => {
    // Why the AGENTS.md entry exists although the paragraph matches nothing
    // today: it is the one place in the repo that must be able to state the
    // prohibition in full, example included, without the guard going red.
    const withExample = 'Never add prices — a $9 plan belongs on the pricing page.';
    const findings = scanText('AGENTS.md', withExample, rules);
    const allowlist = loadAllowlist();

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => isAllowlisted(f.file, f.ruleId, allowlist))).toBe(true);
  });
});

describe('SHAPE_RULE_NOTES', () => {
  it('describes every committed shape rule and nothing else', () => {
    const ids = loadShapeRules().map((r) => r.id);

    expect(ids.sort()).toEqual(Object.keys(SHAPE_RULE_NOTES).sort());
  });

  it('holds no entry for a private-tier id block', () => {
    expect(Object.keys(SHAPE_RULE_NOTES).some((id) => /^BND-[49]/.test(id))).toBe(false);
  });
});

describe('shape-rules.tsv stays inside the portable subset', () => {
  const text = readFileSync(join(SCRIPTS_DIR, 'boundary/shape-rules.tsv'), 'utf8');
  const patterns = text
    .split('\n')
    .filter((l) => l.includes('\t') && !l.trimStart().startsWith('#'))
    .map((l) => l.slice(l.indexOf('\t') + 1));

  it('uses no lookaround, which POSIX ERE has no syntax for', () => {
    expect(patterns.every((p) => !/\(\?[=!<]/.test(p))).toBe(true);
  });

  it('uses no \\b, which is a GNU extension rather than ERE', () => {
    expect(patterns.every((p) => !p.includes('\\b'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

describe('scanText', () => {
  const rules = parseRuleset('BND-901\tneedle\n', 'private', 'test');

  it('reports a 1-based line number', () => {
    expect(scanText('a.md', 'x\ny\nneedle\n', rules)).toEqual([
      { file: 'a.md', line: 3, ruleId: 'BND-901' },
    ]);
  });

  it('scans the last line of a body with no trailing newline', () => {
    expect(scanText('a.md', 'x\nneedle', rules)).toHaveLength(1);
  });

  it('treats an empty file as legitimately empty, not as a broken scan', () => {
    expect(scanText('a.md', '', rules)).toEqual([]);
  });

  it('strips a trailing CR, so an end-anchored rule still matches in a CRLF file', () => {
    const anchored = parseRuleset('BND-901\tneedle$\n', 'private', 'test');

    expect(scanText('a.md', 'the needle\r\nnext\r\n', anchored)).toHaveLength(1);
  });

  it('reports every rule that matched one line, not just the first', () => {
    const two = parseRuleset('BND-901\tneedle\nBND-902\tneed\n', 'private', 'test');

    expect(scanText('a.md', 'needle\n', two).map((f) => f.ruleId)).toEqual(['BND-901', 'BND-902']);
  });
});

describe('collectFiles', () => {
  it('finds prose and source, skips node_modules, lockfiles, and the ruleset itself', () => {
    const root = makeTempDir();
    seedFile(root, 'README.md', '#\n');
    seedFile(root, 'apps/server/src/index.ts', '\n');
    seedFile(root, 'infra/deploy.sh', '\n');
    seedFile(root, 'config/app.yaml', '\n');
    seedFile(root, 'pnpm-lock.yaml', '\n');
    seedFile(root, 'assets/logo.png', '\n');
    seedFile(root, 'node_modules/pkg/index.ts', '\n');
    seedFile(root, 'dist/bundle.js', '\n');
    seedFile(root, 'scripts/boundary/shape-rules.tsv', '\n');

    const found = collectFiles(root).map((f) => f.slice(root.length + 1));

    expect(found.sort()).toEqual([
      'README.md',
      'apps/server/src/index.ts',
      'config/app.yaml',
      'infra/deploy.sh',
    ]);
  });
});

describe('isAllowlisted', () => {
  const allowlist: AllowlistEntry[] = [
    { path: 'meta/', rules: ['BND-301'], reason: 'strategy artifacts' },
    { path: 'vendor/', reason: 'not ours' },
  ];

  it('suppresses a covered rule at a covered path', () => {
    expect(isAllowlisted('meta/plan.md', 'BND-301', allowlist)).toBe(true);
  });

  it('does not suppress an uncovered rule at that path', () => {
    expect(isAllowlisted('meta/plan.md', 'BND-901', allowlist)).toBe(false);
  });

  it('does not suppress the covered rule elsewhere', () => {
    expect(isAllowlisted('docs/plan.md', 'BND-301', allowlist)).toBe(false);
  });

  it('an entry with no rules[] covers every rule at its path', () => {
    expect(isAllowlisted('vendor/x.md', 'BND-901', allowlist)).toBe(true);
  });
});

describe('runBoundaryGuard', () => {
  it('applies the allowlist and still reports everything else', () => {
    const root = makeTempDir();
    const rules = parseRuleset('BND-901\tneedle\n', 'private', 'test');
    seedFile(root, 'meta/ok.md', 'needle\n');
    seedFile(root, 'docs/bad.md', 'needle\n');

    const { findings } = runBoundaryGuard(root, rules, [
      { path: 'meta/', rules: ['BND-901'], reason: 'test' },
    ]);

    expect(findings).toEqual([{ file: 'docs/bad.md', line: 1, ruleId: 'BND-901' }]);
  });

  it('skips binary content hiding behind a text extension', () => {
    const root = makeTempDir();
    const rules = parseRuleset('BND-901\tneedle\n', 'private', 'test');
    seedFile(root, 'docs/blob.json', `needle${'\u0000'}\n`);

    expect(runBoundaryGuard(root, rules, []).findings).toEqual([]);
  });

  it('reports how many files it scanned, so "clean" can be told from "scanned nothing"', () => {
    const root = makeTempDir();
    seedFile(root, 'docs/a.md', 'x\n');
    seedFile(root, 'docs/b.md', 'x\n');

    expect(runBoundaryGuard(root, [], []).filesScanned).toBe(2);
  });

  it('does not follow a symlinked directory out of the tree', () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    seedFile(outside, 'private.md', 'needle\n');
    symlinkSync(outside, join(root, 'link'));

    const result = runBoundaryGuard(root, parseRuleset('BND-901\tneedle\n', 'private', 't'), []);

    expect(result).toMatchObject({ findings: [], filesScanned: 0 });
  });
});

// ---------------------------------------------------------------------------
// A clean verdict over nothing is not a verdict
// ---------------------------------------------------------------------------

describe('zero-subject and unreadable-configuration failures exit 2, not 0 or 1', () => {
  it('a root with no scannable file fails rather than reporting clean', () => {
    const { status, output } = runCli(join(makeTempDir(), 'does-not-exist'));

    expect(status).toBe(2);
    expect(output).toContain('scanned 0 files');
  });

  it('a malformed allowlist is a cannot-run, not a finding', () => {
    // Pinned through the exported validator: before it existed, `entries` of
    // the wrong shape threw a TypeError out of isAllowlisted on the first
    // finding, and Node exited 1 — which CI reads as "boundary hits found".
    expect(() => validateAllowlist({})).toThrow(BoundaryError);
    expect(() => validateAllowlist({ entries: null })).toThrow(BoundaryError);
  });

  it('rejects an entry whose empty path would exempt every file', () => {
    expect(() => validateAllowlist({ entries: [{ path: '', reason: 'typo' }] })).toThrow(
      BoundaryError
    );
    expect(() => validateAllowlist({ entries: [{ path: '   ', reason: 'typo' }] })).toThrow(
      BoundaryError
    );
  });

  it('rejects an entry with no reason — the file is an audit trail', () => {
    expect(() => validateAllowlist({ entries: [{ path: 'docs/' }] })).toThrow(BoundaryError);
  });

  it('rejects a malformed rules list', () => {
    expect(() => validateAllowlist({ entries: [{ path: 'd/', reason: 'r', rules: [] }] })).toThrow(
      BoundaryError
    );
    expect(() =>
      validateAllowlist({ entries: [{ path: 'd/', reason: 'r', rules: 'BND-301' }] })
    ).toThrow(BoundaryError);
  });

  it('accepts the committed allowlist', () => {
    expect(loadAllowlist().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Regression canary: the real tree, the real rules, the real allowlist
// ---------------------------------------------------------------------------

describe('regression canary — this checkout', () => {
  it('is clean under the committed shape rules and allowlist', () => {
    const { findings } = runBoundaryGuard(REPO_ROOT, loadShapeRules(), loadAllowlist());
    const rendered = findings.map((f) => `${f.file}:${f.line}  ${f.ruleId}`);

    expect(rendered).toEqual([]);
  });

  it('actually scanned the tree — a clean verdict over nothing is not a verdict', () => {
    const { filesScanned } = runBoundaryGuard(REPO_ROOT, loadShapeRules(), loadAllowlist());

    expect(filesScanned).toBeGreaterThan(5000);
  });

  it('scans its own source and its own pin suite', () => {
    // EXCLUDED_SEGMENTS claims only scripts/boundary/ is exempt, so a real
    // private term pasted into a fixture here is still caught by the tier-2
    // half. That claim was briefly FALSE: both files were written with a raw
    // NUL byte in them, and the binary skip dropped them from the scan.
    const scanned = collectFiles(REPO_ROOT).map((f) => f.slice(REPO_ROOT.length + 1));

    expect(scanned).toContain('scripts/__tests__/check-boundary.test.ts');
    expect(scanned).toContain('scripts/check-boundary.ts');
    expect(scanned).not.toContain('scripts/boundary/shape-rules.tsv');
  });
});
