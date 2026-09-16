/**
 * Fail the build when something that belongs to the closed-source side of
 * DorkOS Cloud appears in this repository's source or prose.
 *
 * WHY THIS EXISTS. AGENTS.md ("## DorkOS Cloud") states the rule: the control
 * plane is closed-source, and prices, plan names, margins and supplier terms
 * never come here. A rule with no guard rots. A cold-start audit on 2026-09-13
 * found two live examples — a tracked public spec naming the closed-source
 * repository, and the operator's local parent directory pasted into research
 * prose — neither of which any check could have caught. This is that check
 * (DOR-2024).
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING ELSE. This guard runs in a PUBLIC
 * repository whose Actions logs are world-readable. On the one event it exists
 * for — a private term reaching public source — a guard that prints the match
 * publishes that term to a public log, permanently, and far more durably than
 * the paste it caught. So this script NEVER prints matched text. Not for a
 * private rule, not for a shape rule, not in a diagnostic, not in an error.
 * A finding is `path:line  rule-id` and nothing more, and the code physically
 * cannot do otherwise: {@link scanText} asks each pattern `test()` and never
 * `exec()`, so no matched substring is ever captured into a value that could
 * be printed by accident. See {@link BoundaryError} for the error-path half of
 * the same discipline.
 *
 * TWO TIERS.
 *
 *   Tier 1 — `boundary/shape-rules.tsv`, committed here. Regexes that describe
 *   FORMS rather than secrets: a private-looking hostname, a money-shaped
 *   string next to a plan-shaped word. Publishing them leaks nothing, and
 *   anyone reviewing this guard can read them. Tier 1 is SMALLER than it looks
 *   like it should be, and that file's header explains the one that got away:
 *   a local absolute path is the most obvious shape in the guard and it cannot
 *   be a tier-1 rule here, because what separates a leaked path from a fixture
 *   path in a program that manages other people's home directories is whose
 *   name is in it — a value, not a shape.
 *
 *   Tier 2 — the exact term list, never committed here. It lives on the private
 *   side and reaches CI as the organisation-level Actions secret
 *   `BOUNDARY_TERMS`, whose content is the same wire format as the tier-1 file
 *   so ONE loader reads both and the two halves cannot drift.
 *
 * Why not hashes, which was the other option the issue floated: a hash of a
 * short, guessable token — a tier name, a hostname, a repository name — falls
 * to a wordlist in seconds, so the confidentiality is theatre; and hashing
 * forces exact-token matching, while real leaks arrive possessive, hyphenated,
 * pluralised or mid-sentence. A regex catches those; a token hash cannot.
 *
 * MODES, AND WHY THE EMPTY ONE IS THE DANGEROUS ONE. A pull request from a
 * fork gets no secrets, so the guard must be able to run on shape rules alone
 * — and must SAY so, because a job that quietly ran half a ruleset is worse
 * than one that failed. The real hazard is not a fork: it is an empty ruleset
 * silently passing everything on a maintainer's branch because the secret was
 * renamed or rotated away. So generic mode is never a fallback. The caller
 * declares, through `BOUNDARY_REQUIRE_TERMS`, whether a private ruleset is
 * expected; when it is expected and is missing, empty, or parses to zero
 * rules, this exits 2 rather than passing.
 *
 *   BOUNDARY_TERMS          the private ruleset's text (GitHub sets this to the
 *                           empty string when the secret does not exist, which
 *                           is why its emptiness alone cannot mean "broken").
 *   BOUNDARY_REQUIRE_TERMS  non-empty when the caller believes a private
 *                           ruleset should be present.
 *
 * THREE EXIT CODES, NOT TWO. `0` clean, `1` findings, `2` the guard could not
 * run. That third one is load-bearing: with two codes, "the tree is clean" and
 * "the ruleset was empty" are the same answer, which is the silent-pass hazard
 * wearing a different hat. A missing or empty expected ruleset, a malformed
 * ruleset line, a duplicate rule id and a pattern that does not compile are
 * all `2`.
 *
 * WHAT IT SCANS. Every file under the repo root with a prose, config or source
 * extension ({@link SCANNED_EXTENSIONS}), skipping {@link EXCLUDED_SEGMENTS}
 * (`node_modules`, build output, `.git`) and {@link EXCLUDED_BASENAMES}
 * (lockfiles). Line-oriented, case-insensitive, one line at a time — unlike
 * `check-vocab-gate.ts`, which parses TypeScript because it has to tell a
 * copy string from an identifier. This guard has the opposite problem: a
 * hostname is just as much a leak in a comment, a YAML value or a README as it
 * is in rendered copy, so a line scan over every surface is the right tool and
 * an AST walk would see a fraction of the ground. That is why this is a
 * sibling of the vocab gate rather than another wave inside it.
 *
 * WHERE IT RUNS. The `typecheck` workflow, beside the two vocabulary gates and
 * for the same reason they are there: `typecheck` is already a required status
 * check and already reports on `merge_group`, so a gate that rides it fails the
 * merge rather than a workflow nobody was watching. Pinned by
 * `scripts/__tests__/check-boundary.test.ts`, run by `scripts-test.yml`.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-boundary.ts [repoRoot]
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** `relative()`'s output with OS separators normalized to `/`, for portable path matching. */
function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

/**
 * A failure that stops the guard from running (exit 2).
 *
 * Its message is written by this file and never interpolates ruleset text,
 * scanned text, or another error's message. That last exclusion is the subtle
 * one and the reason this class exists: `new RegExp(bad)` throws a
 * `SyntaxError` whose message QUOTES THE PATTERN, and a tier-2 pattern is a
 * private term. Re-throwing or logging that error publishes the term to a
 * world-readable log — on the error path, which no ordinary test exercises.
 * So every `new RegExp` in this file is wrapped, the original error is
 * discarded, and what surfaces names the rule id and nothing else.
 */
export class BoundaryError extends Error {}

/** One compiled rule: a stable id and the pattern it matches. */
export interface BoundaryRule {
  /**
   * Stable, never reused or renumbered — a guard reports the id and only the
   * id, so an id that changes meaning silently changes what every past
   * failure meant.
   */
  id: string;
  /** Compiled case-insensitively, without `g`, and only ever used via `test()`. */
  pattern: RegExp;
  /** Which tier the rule came from, for the mode line and the printed legend. */
  tier: 'shape' | 'private';
}

/** A scoped exception: files at `path` may keep matching some or all rules. */
export interface AllowlistEntry {
  /** Plain substring matched against the finding's repo-relative path. */
  path: string;
  /** Rule ids this entry covers. Absent means "every rule". */
  rules?: string[];
  /** Why the match is legitimate — required so the file stays an audit trail. */
  reason: string;
}

/**
 * One boundary hit. There is deliberately no `snippet`, no `match` and no
 * `column`: every one of those would be a place for private text to reach a
 * public log, and a reviewer resolves a hit by opening the file, not by
 * reading CI.
 */
export interface Finding {
  file: string;
  line: number;
  ruleId: string;
}

/** Which halves of the ruleset a run was built from. */
export type BoundaryMode = 'shape-only' | 'shape+terms';

/** Path segments excluded outright — not scoped exceptions, just not source. */
const EXCLUDED_SEGMENTS = [
  '/.git/',
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/.next/',
  '/.turbo/',
  '/.vercel/',
  '/playwright-report/',
  '/test-results/',
  // The tier-1 ruleset is a file whose entire content is the patterns
  // themselves; scanning it means scanning a regex for the thing it matches.
  // Narrow on purpose — everything else under scripts/, including this guard's
  // own pin suite, IS scanned, so a real private term pasted into a fixture is
  // still caught by the tier-2 half. That claim is asserted, not assumed: see
  // the "scans its own pin suite" case in check-boundary.test.ts. It stopped
  // being true once, when both new files were written with a raw NUL byte in
  // them and the binary skip below quietly dropped them from the scan.
  '/scripts/boundary/',
];

/** Files excluded by name — generated, enormous, and not authored by anyone. */
const EXCLUDED_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'CHANGELOG.md',
]);

/** Prose, config and source extensions. Everything else is skipped as binary or opaque. */
const SCANNED_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.yml',
  '.yaml',
  '.json',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.sh',
]);

/**
 * A one-line, public-safe description per tier-1 rule id, printed as a legend
 * under a failure so a contributor knows what shape tripped without the guard
 * quoting their line back at them.
 *
 * Tier-2 ids get no entry here on purpose — a description of a private rule is
 * a description of a private term. They resolve against the private list.
 *
 * Kept in lockstep with `boundary/shape-rules.tsv` by the pin suite: an id in
 * one and not the other fails the tests.
 */
export const SHAPE_RULE_NOTES: Record<string, string> = {
  'BND-201': 'a hostname whose leftmost label names an internal-facing service',
  'BND-301': 'a money amount followed closely by a plan- or billing-shaped word',
  'BND-302': 'a plan- or billing-shaped word followed closely by a money amount',
  'BND-303': 'a margin stated as a percentage',
};

/**
 * Compile one pattern, discarding the compiler's own error.
 *
 * @param id - Rule id, the only thing that may appear in the failure.
 * @param source - The pattern text. NEVER logged, NEVER returned in an error.
 */
function compileRule(id: string, source: string, tier: BoundaryRule['tier']): BoundaryRule {
  try {
    return { id, pattern: new RegExp(source, 'i'), tier };
  } catch {
    // Deliberately swallowing the cause: its message quotes the pattern.
    throw new BoundaryError(`rule ${id} does not compile (its pattern is not printed here)`);
  }
}

/**
 * Parse a ruleset in the shared wire format: one rule per line, `<rule-id>`,
 * a tab, then a regular expression. `#` comments and blank lines are ignored,
 * and there is no third column.
 *
 * Diagnostics name a LINE NUMBER, never the line — in a tier-2 ruleset the
 * line is a private term.
 *
 * @param text - The ruleset's full text. A missing trailing newline is fine:
 *   the last line is still parsed.
 * @param tier - Which half this text came from.
 * @param label - Human name for the source, used only in diagnostics.
 */
export function parseRuleset(
  text: string,
  tier: BoundaryRule['tier'],
  label: string
): BoundaryRule[] {
  const rules: BoundaryRule[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const tab = raw.indexOf('\t');
    if (tab <= 0 || tab === raw.length - 1) {
      throw new BoundaryError(
        `${label}: line ${i + 1} is not "<rule-id>\\t<regex>" (the line is not printed here)`
      );
    }
    const id = raw.slice(0, tab).trim();
    const source = raw.slice(tab + 1);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(id)) {
      throw new BoundaryError(`${label}: line ${i + 1} has a malformed rule id`);
    }
    if (seen.has(id)) {
      throw new BoundaryError(`${label}: rule id ${id} is defined twice`);
    }
    seen.add(id);
    rules.push(compileRule(id, source, tier));
  }

  return rules;
}

/**
 * Load the committed tier-1 shape rules.
 *
 * @param path - Path to `shape-rules.tsv`. Defaults to the file beside this script.
 */
export function loadShapeRules(
  path: string = join(SCRIPT_DIR, 'boundary/shape-rules.tsv')
): BoundaryRule[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new BoundaryError(`cannot read the committed shape ruleset at ${path}`);
  }
  const rules = parseRuleset(text, 'shape', 'shape-rules.tsv');
  if (rules.length === 0) {
    throw new BoundaryError('the committed shape ruleset parsed to zero rules');
  }
  return rules;
}

/**
 * Load the allowlist.
 *
 * @param path - Path to `allowlist.json`. Defaults to the file beside this script.
 */
export function loadAllowlist(
  path: string = join(SCRIPT_DIR, 'boundary/allowlist.json')
): AllowlistEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // The parser's message quotes the offending snippet, which is file content.
    throw new BoundaryError(`cannot read or parse the boundary allowlist at ${path}`);
  }
  return validateAllowlist(data);
}

/**
 * Check an allowlist's shape before anything trusts it.
 *
 * Every rejection here is a real way this guard has to go quietly wrong. An
 * `entries` that is not an array throws a `TypeError` out of `isAllowlisted`
 * on the FIRST finding, which reaches CI as exit 1 — "boundary hits found" —
 * rather than exit 2, collapsing the very distinction the three exit codes
 * exist to keep. And an entry whose `path` is the empty string matches every
 * file (`''.includes('') === true`), so one typo turns a required gate into a
 * green no-op with no diagnostic at all.
 *
 * @param data - Parsed JSON, of unknown shape.
 */
export function validateAllowlist(data: unknown): AllowlistEntry[] {
  const entries = (data as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new BoundaryError('the boundary allowlist has no `entries` array');
  }
  return entries.map((raw, i) => {
    const entry = raw as Partial<AllowlistEntry>;
    const at = `allowlist entry ${i}`;
    if (typeof entry?.path !== 'string' || entry.path.trim() === '') {
      throw new BoundaryError(`${at} has no non-empty \`path\` (an empty path matches every file)`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new BoundaryError(`${at} has no \`reason\` — this file is an audit trail`);
    }
    if (
      entry.rules !== undefined &&
      (!Array.isArray(entry.rules) ||
        entry.rules.length === 0 ||
        entry.rules.some((r) => typeof r !== 'string' || r.trim() === ''))
    ) {
      throw new BoundaryError(`${at} has a malformed \`rules\` list`);
    }
    return { path: entry.path, reason: entry.reason, ...(entry.rules && { rules: entry.rules }) };
  });
}

/**
 * Build the full ruleset for a run and decide the mode.
 *
 * Generic mode is entered only on purpose. When `BOUNDARY_REQUIRE_TERMS` is
 * set, a private ruleset that is absent, empty, or parses to zero rules is a
 * hard failure rather than a quiet downgrade — that downgrade is precisely how
 * a renamed secret turns a required check into a green no-op.
 *
 * @param env - Environment to read `BOUNDARY_TERMS` and `BOUNDARY_REQUIRE_TERMS` from.
 * @param shapeRules - The tier-1 rules, already loaded.
 */
export function buildRuleset(
  env: NodeJS.ProcessEnv,
  shapeRules: BoundaryRule[]
): { mode: BoundaryMode; rules: BoundaryRule[]; privateRuleCount: number } {
  const required = (env.BOUNDARY_REQUIRE_TERMS ?? '').trim() !== '';
  const supplied = env.BOUNDARY_TERMS ?? '';

  if (supplied.trim() === '') {
    if (required) {
      throw new BoundaryError(
        'BOUNDARY_REQUIRE_TERMS is set but BOUNDARY_TERMS is empty — the private ' +
          'ruleset is missing. Refusing to run in shape-only mode when a full ' +
          'ruleset was expected.'
      );
    }
    return { mode: 'shape-only', rules: shapeRules, privateRuleCount: 0 };
  }

  const privateRules = parseRuleset(supplied, 'private', 'BOUNDARY_TERMS');
  if (privateRules.length === 0) {
    throw new BoundaryError(
      'BOUNDARY_TERMS is set but parsed to zero rules — it is all comments or ' +
        'blank lines. Refusing to pass on an empty ruleset.'
    );
  }

  const shapeIds = new Set(shapeRules.map((r) => r.id));
  for (const rule of privateRules) {
    if (shapeIds.has(rule.id)) {
      throw new BoundaryError(`rule id ${rule.id} is defined in both tiers`);
    }
  }

  return {
    mode: 'shape+terms',
    rules: [...shapeRules, ...privateRules],
    privateRuleCount: privateRules.length,
  };
}

/**
 * Whether a finding at `filePath` for `ruleId` is covered by an allowlist entry.
 *
 * @param filePath - Repo-relative path the finding was found at.
 * @param ruleId - The rule that matched.
 * @param allowlist - Entries to check against.
 */
export function isAllowlisted(
  filePath: string,
  ruleId: string,
  allowlist: AllowlistEntry[]
): boolean {
  return allowlist.some(
    (entry) =>
      filePath.includes(entry.path) && (entry.rules === undefined || entry.rules.includes(ruleId))
  );
}

/**
 * Scan one already-read file's text.
 *
 * `test()`, never `exec()`: the only question asked of a line is whether it
 * matched, so no matched substring is ever captured into a value this process
 * holds. An empty file scans zero lines and passes — deliberately, not by
 * accident — and a file with no trailing newline still has its last line
 * scanned, which is the usual shape of text that came back from an API.
 *
 * A trailing `\r` is stripped before matching, as {@link parseRuleset} does to
 * its own input: without it an end-anchored rule silently stops matching in a
 * CRLF file, and a tier-2 author cannot see this file to know that.
 *
 * KNOWN GAP, deliberate. The scan is line-oriented, so it cannot see a fact
 * spread across two lines. The concrete case is a Markdown pricing table,
 * where the plan word lives in the header row and the amount in the body row:
 * neither line carries both, so BND-301 and BND-302 are blind to it. Closing
 * that means a stateful, format-aware scan, which is a different program.
 * Named here rather than solved, so nobody reads the gate as covering it.
 *
 * @param filePath - Repo-relative path, reported verbatim in findings.
 * @param text - The file's content.
 * @param rules - Compiled rules to test each line against.
 */
export function scanText(filePath: string, text: string, rules: BoundaryRule[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line === '') continue;
    for (const rule of rules) {
      if (rule.pattern.test(line)) findings.push({ file: filePath, line: i + 1, ruleId: rule.id });
    }
  }
  return findings;
}

/**
 * Recursively collect scannable files under `repoRoot`, applying the exclusions.
 *
 * `lstatSync`, not `statSync`: a symlinked directory is skipped rather than
 * followed, so the walk cannot leave the checkout (a link to a sibling folder
 * would be scanned and reported under an escaping path) and cannot loop.
 */
export function collectFiles(repoRoot: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const normalized = `/${toPosixRelative(repoRoot, full)}/`;
      if (EXCLUDED_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue; // A broken symlink is not this guard's problem.
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (EXCLUDED_BASENAMES.has(entry)) continue;
      const dot = entry.lastIndexOf('.');
      if (dot <= 0) continue;
      if (SCANNED_EXTENSIONS.has(entry.slice(dot))) files.push(full);
    }
  }

  walk(repoRoot);
  return files;
}

/**
 * Run the guard over a checkout.
 *
 * Returns the file count as well as the findings, because "clean" and "scanned
 * nothing" are otherwise the same answer. A wrong root, a checkout step that
 * did not run, or a future exclusion bug all render as success unless the
 * caller can ask what the check actually counted.
 *
 * @param repoRoot - Repo root to scan from.
 * @param rules - Compiled rules from {@link buildRuleset}.
 * @param allowlist - Scoped exceptions.
 */
export function runBoundaryGuard(
  repoRoot: string,
  rules: BoundaryRule[],
  allowlist: AllowlistEntry[]
): { findings: Finding[]; filesScanned: number } {
  const findings: Finding[] = [];
  const files = collectFiles(repoRoot);
  for (const file of files) {
    const relPath = toPosixRelative(repoRoot, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // Binary content behind a text extension.
    for (const finding of scanText(relPath, text, rules)) {
      if (isAllowlisted(finding.file, finding.ruleId, allowlist)) continue;
      findings.push(finding);
    }
  }
  return { findings, filesScanned: files.length };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = process.argv[2] ?? join(SCRIPT_DIR, '..');

  let mode: BoundaryMode;
  let rules: BoundaryRule[];
  let allowlist: AllowlistEntry[];
  let privateRuleCount: number;
  let findings: Finding[];
  let filesScanned: number;
  try {
    const shapeRules = loadShapeRules();
    ({ mode, rules, privateRuleCount } = buildRuleset(process.env, shapeRules));
    allowlist = loadAllowlist();

    console.log(
      mode === 'shape+terms'
        ? `boundary: mode=shape+terms — private ruleset loaded (${privateRuleCount} rule${privateRuleCount === 1 ? '' : 's'})`
        : 'boundary: mode=shape-only — generic mode, shape patterns only'
    );

    // Inside the try on purpose: a scan that throws must exit 2 ("could not
    // run"), not 1 ("found hits"). Before this, a malformed allowlist threw a
    // TypeError out here and Node exited 1, which CI reads as a finding.
    ({ findings, filesScanned } = runBoundaryGuard(repoRoot, rules, allowlist));

    if (filesScanned === 0) {
      throw new BoundaryError(
        `scanned 0 files under ${repoRoot} — a clean verdict over nothing is not a verdict`
      );
    }
  } catch (error) {
    // Only a BoundaryError's message is safe to print — see that class. Anything
    // else is reported by its constructor name, because a stray error's message
    // may carry text this guard must not publish.
    const safe =
      error instanceof BoundaryError
        ? error.message
        : `unexpected ${(error as { constructor?: { name?: string } })?.constructor?.name ?? 'error'} (message withheld)`;
    console.error(`check-boundary: cannot run — ${safe}`);
    process.exit(2);
  }

  if (findings.length > 0) {
    console.error(`\ncheck-boundary: ${findings.length} boundary hit(s):\n`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.ruleId}`);

    const shapeIds = [...new Set(findings.map((f) => f.ruleId))]
      .filter((id) => id in SHAPE_RULE_NOTES)
      .sort();
    if (shapeIds.length > 0) {
      console.error('\nShape rules that fired:');
      for (const id of shapeIds) console.error(`  ${id}  ${SHAPE_RULE_NOTES[id]}`);
    }
    console.error(
      '\nThis guard never prints the matched text: its logs are public, and ' +
        'printing the match would publish the very thing it caught. Open the ' +
        'file at the line above. An id not listed under "Shape rules that ' +
        'fired" comes from the private ruleset — resolve it against that list, ' +
        'or ask an operator.\n' +
        'If the match is genuinely legitimate, add a scoped entry with a reason ' +
        'to scripts/boundary/allowlist.json.'
    );
    process.exit(1);
  }

  console.log(
    `check-boundary: clean — 0 hits from ${rules.length} rule(s) over ${filesScanned} file(s).`
  );
}
