/**
 * Fail a change that rewrites user-visible copy a browser spec still asserts.
 *
 * WHY THIS EXISTS (DOR-1647). `browser-test` is an instant pass-through on
 * `pull_request` and only runs the Playwright shards on `merge_group` — the
 * saturation trade `.github/workflows/browser-test.yml` explains at length. The
 * cost of that trade is one specific failure class: apps/e2e deliberately
 * asserts literal product copy, so a PR that rewrites a string is fully green at
 * PR time and only reds inside the queue, where a red is a queue EJECTION that
 * also silently disarms auto-merge. That happened twice in one day on
 * 2026-08-31 — #1397's em-dash sweep broke `mcp-oauth-signin.spec.ts` and
 * `compaction.ts`, #1406's setting removal broke `settings-dialog.spec.ts` —
 * each costing a dequeue, a fix and a re-arm, with operator attention in the
 * middle. This script is the cheap PR-time signal that catches the string half
 * of that class in seconds instead of forty minutes.
 *
 * THE QUESTION IT ANSWERS, stated exactly:
 *
 *   Does this change delete a run of authored copy from a file, while some
 *   string under `apps/e2e` still spans that run and nothing at HEAD covers
 *   the same span more specifically?
 *
 * All three clauses matter. "Deleted" alone is noise (copy is rewritten
 * constantly); "quoted in apps/e2e" alone is noise (the suite quotes plenty of
 * copy nothing changed); and the third clause is what keeps a rewrite that only
 * lengthens or relocates a string from reading as a deletion. Their
 * intersection is, near enough, the definition of the regression: a locator
 * that can no longer match.
 *
 * MEASURED, not asserted. Replayed against the real 2026-08-31 trees — #1397's
 * client copy paired with the browser suite as it stood before the queue
 * ejection forced a fix — the rule reports exactly the two specs that broke
 * (`compaction.ts:182` and `mcp-oauth-signin.spec.ts:117`) and nothing else,
 * out of seventeen runs of copy that PR deleted. Replayed the same way across
 * the twelve most recent merges that touched `apps/client/src`, every one of
 * which passed the merge-queue shards, it reports nothing at all. That is the
 * calibration behind every threshold below; changing one without re-running
 * that replay is how a gate turns into noise.
 *
 * WHY IT COMPARES CHUNKS, NOT WHOLE STRINGS. The two regressions this ticket
 * cites are both interpolated, so no whole string is shared between component
 * and spec:
 *
 *   component  `Compacted context — ${pre} → ${post} tokens`
 *   spec       toContainText('Compacted context — 51.2k → 4.2k tokens')
 *
 * What IS shared is the template's static chunk, `Compacted context —`. So a
 * template literal contributes its head and every span literal SEPARATELY, and
 * a spec string counts as a hit when it OVERLAPS a removed chunk. Substring
 * containment is also what Playwright itself does: `getByText` matches on
 * substring unless `{ exact: true }` is passed.
 *
 * OVERLAP RUNS BOTH WAYS (DOR-1819). The first version only asked whether the
 * SPEC string contains the removed run, and PR #1549 walked straight through
 * that hole: the component's chunk was
 * `live sessions — open the session switcher for` (45 characters) while the
 * spec's regex asked for `live sessions — open the session switcher` (41), so
 * the spec string was the SHORTER of the two and containment never fired. Both
 * sides are interpolated in practice, so which one is broader is an accident of
 * where each side chose to stop — never a signal. {@link Overlap} names the two
 * shapes and {@link dropSupported} rules on each with the evidence that shape
 * actually admits.
 *
 * WHY "REMOVED" IS JUDGED PER FILE AND "STILL RENDERS" PER SPEC STRING. The
 * first rule tried was the obvious one — a chunk counts as removed when it
 * appears nowhere in the whole app corpus at HEAD. It catches the compaction
 * break and MISSES the MCP one, because the em-dash sweep left the eleven
 * characters `Connected —` alive in an unrelated component
 * (`OllamaLocalPath.tsx`), and a corpus-wide test cannot tell that occurrence
 * apart from the one the spec depends on. Short generic runs collide; a
 * corpus-wide test is therefore blind to exactly the copy most likely to be
 * quoted.
 *
 * So removal is judged against the CHANGED FILES only (which still absorbs a
 * move, since both ends of a move are changed files), and the corpus is used
 * for a narrower job: it suppresses a finding when some chunk at HEAD covers
 * the spec string MORE specifically than the removed run does — longer, and
 * still contained in the same spec string. That is what "the copy just grew"
 * or "it moved and got longer" looks like, and it is the only shape the corpus
 * can honestly rule on. `Connected —` in an unrelated component is exactly as
 * long as the run that vanished, so it no longer suppresses anything.
 *
 * AND IT MUST COVER THE RUN THAT VANISHED (DOR-1819). "Longer, and inside the
 * same spec string" was not enough on its own. #1549 reworded
 * `${who} ${be} still working — ${TAKING_LONGER}` to `…still working, …`, and
 * the finding was suppressed by `TAKING_LONGER` itself — a longer, UNCHANGED
 * constant in the very same file, which the spec string of course also spans,
 * and which says nothing whatever about the em dash that disappeared. A
 * supporting run now has to CONTAIN the removed run as well, which is what "the
 * copy just grew around it" means and what an unrelated neighbouring constant
 * can never do.
 *
 * WHY IT DOES NOT REUSE THE VOCAB GATE'S COPY-SINK CLASSIFIER. `isCopySink` in
 * `check-vocab-gate.ts` is the obvious candidate and was the first thing tried;
 * it is the wrong tool here, for a reason its own module doc already writes
 * down. That classifier only recognises copy in a NAMED position (a JSX
 * attribute, a `{ label: … }` property, a `toast.*` argument) and its header
 * names `return 'Some copy'` as a known, unclosed gap. Both regressions above
 * are bare returns — `return \`Compacted context · … tokens\`` in
 * `CompactBoundaryRow.tsx` — so a gate keyed on that classifier would have
 * missed the exact two failures it was built for. This script therefore takes
 * EVERY string, template chunk and JSX text node in the changed file and leans
 * on a different filter: a chunk only becomes a finding if apps/e2e also
 * contains it. A discriminant like `case 'connection':` or an import specifier
 * never survives that, because {@link isProseChunk} already requires two words
 * and ten characters, and no browser spec quotes an identifier.
 *
 * WHAT IT CANNOT CATCH, so nobody mistakes a green run for a browser run:
 *
 *   - Structural assertions. #1406's other break was a `toHaveCount(7)` on
 *     settings switches after a setting was deleted; no string is involved and
 *     nothing here sees it. Only the merge-queue suite catches that shape.
 *   - Copy assembled from values this script cannot join — a label built from
 *     a lookup table keyed by an enum, or text that only exists after i18n.
 *   - A spec that builds its expectation the same dynamic way the component
 *     does, so neither side holds a literal at all.
 *   - A regex assertion whose source carries metacharacters beyond the anchors
 *     {@link regexLiteralSource} strips. `/^working folder/i` is read exactly;
 *     `/Connected — \d+ tools/` keeps its `\d+` verbatim and therefore matches
 *     no component chunk. Only the literal head of such a pattern would be
 *     comparable, and splitting one out is not attempted here.
 *   - Copy the change removes from a file it touched while an UNCHANGED file
 *     elsewhere still renders the same run. Removal is judged per changed file
 *     on purpose (above), so this direction is a false positive rather than a
 *     miss — say so on the PR; the check is advisory.
 *
 * WHY IT IS STILL NEEDED IF `browser-test` EVER RUNS ON PRs (DOR-1818). It runs
 * in seconds against a diff, where the shards cost forty minutes on a machine
 * that has to be provisioned; and it names the copy that moved, which a
 * Playwright timeout does not. If the shards do start reporting on
 * `pull_request`, this becomes the fast pre-shard signal rather than the only
 * one, and the honest thing to do then is say so here rather than delete it
 * silently.
 *
 * That is a signal, not a proof, and it is deliberately positioned as one: the
 * merge-queue shards remain the gate that decides the merge. This runs on the
 * PR so the common case is caught before it can eject anything.
 *
 * Usage:
 *   pnpm check:copy-spec-drift [baseRef] [repoRoot]
 *
 * `baseRef` defaults to `origin/main`; CI passes the pull request's base SHA.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectFiles } from './check-vocab-gate.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Roots whose authored strings can reach a screen a browser spec drives. The
 * first three are the vocab gate's own scan roots; `packages/shared/src` joins
 * them because schema-level copy (an enum's human label, a Zod error message)
 * renders verbatim in the cockpit and would otherwise read as "deleted from the
 * app" the moment a component stopped inlining it.
 */
const COPY_ROOTS = ['apps/client/src', 'apps/site/src', 'apps/server/src', 'packages/shared/src'];

/**
 * Everything the browser suite is built from — specs, page objects and
 * fixtures alike. A locator lives in a page object at least as often as in a
 * spec, and a fixture that feeds the UI the string a spec then asserts breaks
 * the same run, so the whole app is the corpus rather than `tests/`.
 */
const SPEC_ROOTS = ['apps/e2e'];

/**
 * Shortest chunk that can be a finding. Ten characters plus the two-word rule
 * in {@link isProseChunk} is what separates copy from a key or an identifier,
 * and it is calibrated on a real regression rather than picked round:
 * `Connected —`, the chunk that broke `mcp-oauth-signin.spec.ts`, is eleven.
 */
const MIN_CHUNK_CHARS = 10;

/**
 * How much of a removed run a SHORTER spec string has to cover before the spec
 * is read as depending on that run.
 *
 * Only the `removed-spans-assertion` direction needs this, and the asymmetry is
 * the point. When the spec string is the broader one it asserts the whole of
 * itself, so any run inside it that vanished breaks the locator however small
 * that run is. When the spec string sits INSIDE the removed run it asserts only
 * a fragment, and Playwright's substring matching means the fragment can go on
 * matching anything else that contains it — so a fragment covering nearly all
 * of the run is a dependency, and one covering a third of it is a common phrase
 * that happened to sit there.
 *
 * Calibrated on #1549 itself: the two assertions the change really stranded
 * cover 0.91 (`live sessions — open the session switcher` of
 * `…switcher for`) and 1.0 (`working directory` of `Working Directory`) of
 * their runs, while the one coincidence in the same 190-file batch —
 * `Send message`, a room composer button, sitting inside the settings tool
 * description `Send messages and check the inbox` — covers 0.36.
 */
const MIN_ASSERTION_COVERAGE = 0.6;

/**
 * Path fragments that are never product copy, applied to BOTH sides so the
 * "was it removed" scan and the "does it still exist" scan agree. They mirror
 * `check-vocab-gate.ts`'s list — `collectFiles` applies that one while walking
 * directories, and this one re-applies it to individual paths, which is what a
 * `git diff` name list needs.
 */
const EXCLUDED_SEGMENTS = ['/__tests__/', '/node_modules/', '/dist/', '/apps/client/src/dev/'];

/** One run of authored text, normalized, with where it came from. */
export interface Chunk {
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** 1-based line the chunk starts on. */
  line: number;
  /** Whitespace-collapsed, trimmed text. */
  text: string;
  /**
   * The chunk came from a `/…/i` regex, so every comparison it takes part in
   * must fold case — a case-insensitive locator keeps matching copy whose
   * casing changed, and stops matching copy whose WORDS changed. Only ever set
   * on the apps/e2e side; authored copy is compared verbatim.
   */
  ignoreCase?: boolean;
}

/**
 * Which of the two runs is the broader one. Both shapes are the same
 * regression — a locator that can no longer match — but they admit different
 * evidence that the copy survived, so {@link dropSupported} rules on them
 * separately.
 */
export type Overlap =
  /** The spec string spans the removed run: `'Compacted context — 51.2k…'` over `'Compacted context —'`. */
  | 'assertion-spans-removed'
  /** The removed run spans the spec string: `'live sessions — open the session switcher for'` over `/live sessions — open the session switcher/`. */
  | 'removed-spans-assertion';

/** A browser-suite string that overlaps copy this change removed. */
export interface Finding {
  /** Repo-relative path of the apps/e2e file holding the stale string. */
  specFile: string;
  /** 1-based line of that string. */
  specLine: number;
  /** The full apps/e2e string, normalized. */
  assertion: string;
  /** Whether `assertion` came from a case-insensitive regex. */
  ignoreCase: boolean;
  /** Repo-relative path the removed copy used to live at. */
  copyFile: string;
  /** 1-based line it used to live on. */
  copyLine: number;
  /** The removed chunk `assertion` overlaps. */
  removed: string;
  /** Which run contains which. */
  overlap: Overlap;
}

/**
 * Collapse whitespace so JSX text that wraps across three indented lines
 * compares equal to the single-line string a spec asserts — the same
 * normalization Playwright applies to a text locator.
 *
 * @param raw - Text exactly as the parser produced it.
 */
export function normalizeCopy(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Whether `haystack` contains `outer`, folding case when a case-insensitive
 * regex is one of the two sides.
 *
 * @param haystack - The run that might be the broader one.
 * @param needle - The run that might sit inside it.
 * @param ignoreCase - Set when either side came from a `/…/i` regex.
 */
export function spans(haystack: string, needle: string, ignoreCase = false): boolean {
  if (!ignoreCase) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The literal text a regex literal asks for, with the anchors stripped.
 *
 * `/^working directory/i` is the settings-dialog assertion #1549 broke, and the
 * two characters that made it invisible to the first version of this gate were
 * the `^` (never present in the component's string) and the lower-case `w`
 * (which the `i` flag made irrelevant to Playwright and fatal here). The flags
 * come back alongside the source so the caller can carry `ignoreCase` onto the
 * chunk; the rest of the pattern is returned verbatim, metacharacters included
 * (module doc, "what it cannot catch").
 *
 * @param raw - The literal exactly as written, delimiters and flags included.
 */
export function regexLiteralSource(raw: string): { source: string; ignoreCase: boolean } {
  const end = raw.lastIndexOf('/');
  const flags = raw.slice(end + 1);
  let source = raw.slice(1, end);
  // `^` at position 0 cannot be escaped, so this is always the anchor.
  if (source.startsWith('^')) source = source.slice(1);
  // A trailing `$` IS the anchor unless a backslash escaped it, and an escaped
  // backslash before it un-escapes it again — count the run to tell them apart.
  if (source.endsWith('$')) {
    const backslashes = (/(\\*)\$$/.exec(source)?.[1] ?? '').length;
    if (backslashes % 2 === 0) source = source.slice(0, -1);
  }
  return { source, ignoreCase: flags.includes('i') };
}

/**
 * Whether a normalized chunk is prose worth comparing rather than a key, a
 * path or an identifier.
 *
 * Two words and ten characters is the whole filter, and it carries the weight
 * the copy-sink classifier carries in the vocab gate: it is what keeps
 * `case 'connected':`, `'use client'` and `./sse-connection` out of the corpus
 * without an AST position check that would have missed both regressions this
 * script was built for (see the module doc).
 *
 * @param text - Output of {@link normalizeCopy}.
 */
export function isProseChunk(text: string): boolean {
  if (text.length < MIN_CHUNK_CHARS) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  // Two words. An identifier, an import specifier, a CSS class list joined by
  // hyphens and a Tailwind token are all one "word" by this test.
  if (!/\s/.test(text)) return false;
  // A URL or a path that happens to contain a space is still not copy.
  if (/^(?:https?:|\.{0,2}\/)/.test(text)) return false;
  return true;
}

/**
 * Whether a repo-relative path is one this gate reads on either side.
 *
 * @param relPath - Repo-relative path, POSIX separators.
 */
export function isScannablePath(relPath: string): boolean {
  const path = `/${relPath}`;
  if (!/\.tsx?$/.test(path)) return false;
  return !EXCLUDED_SEGMENTS.some((segment) => path.includes(segment));
}

/**
 * Every prose chunk in one source file.
 *
 * A template literal contributes its head and each span literal separately —
 * that is the whole reason interpolated copy is comparable at all (module doc).
 *
 * @param file - Repo-relative path, used for reporting and to pick the TSX
 *   parse mode.
 * @param text - File contents.
 * @param options - `includeRegex` also harvests regular-expression literals,
 *   which is how the apps/e2e side reads `getByText(/Connected — 2 tools\./)`.
 *   Off for app source, where a regex is a matcher rather than copy.
 */
export function extractChunks(
  file: string,
  text: string,
  options: { includeRegex?: boolean } = {}
): Chunk[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const chunks: Chunk[] = [];

  function record(node: ts.Node, raw: string, ignoreCase = false): void {
    const normalized = normalizeCopy(raw);
    if (!isProseChunk(normalized)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    chunks.push({ file, line: line + 1, text: normalized, ...(ignoreCase ? { ignoreCase } : {}) });
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      record(node, node.getText(sourceFile));
    } else if (ts.isTemplateExpression(node)) {
      // `head` and each `span.literal` are TemplateHead/Middle/Tail, none of
      // which `isStringLiteralLike` accepts, so the walk below never
      // double-counts them.
      record(node.head, node.head.text);
      for (const span of node.templateSpans) record(span.literal, span.literal.text);
    } else if (ts.isStringLiteralLike(node)) {
      record(node, node.text);
    } else if (options.includeRegex === true && ts.isRegularExpressionLiteral(node)) {
      const { source, ignoreCase } = regexLiteralSource(node.getText(sourceFile));
      record(node, source, ignoreCase);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return chunks;
}

/** Run git in `repoRoot` and return stdout. */
function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Files under {@link COPY_ROOTS} this change touched, comparing `baseRef` to
 * the WORKING TREE. In CI those are the same thing; locally it means an
 * uncommitted rewrite is judged too, which is the only way running this by hand
 * before pushing is worth anything.
 *
 * `--no-renames` on purpose: a rename listed as delete + add means the old
 * path's chunks are scanned for removal while the new path's chunks join the
 * same change's HEAD side, so a pure move produces no finding without any
 * rename-aware bookkeeping.
 *
 * @param repoRoot - Checkout to run git in.
 * @param baseRef - The commit the change is measured against.
 */
export function changedCopyFiles(repoRoot: string, baseRef: string): string[] {
  const output = git(repoRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    baseRef,
    '--',
    ...COPY_ROOTS,
  ]);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isScannablePath(line));
}

/**
 * A file's contents at `ref`, or null when it did not exist there.
 *
 * git's stderr is discarded rather than inherited, because "it did not exist
 * there" is a NORMAL answer here — every file a change ADDS reaches this — and
 * an inherited stderr prints `fatal: path … exists on disk, but not in <base>`
 * above the job's own green verdict. A clean run must read as clean.
 */
function readAtRef(repoRoot: string, ref: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Every prose chunk under `roots` in the checkout as it stands now.
 *
 * @param repoRoot - Checkout to walk.
 * @param roots - Repo-relative directories to walk.
 * @param options - Passed through to {@link extractChunks}.
 */
export function collectCorpus(
  repoRoot: string,
  roots: string[],
  options: { includeRegex?: boolean } = {}
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const absolute of collectFiles(roots, repoRoot)) {
    const relative = absolute
      .slice(repoRoot.length + 1)
      .split('\\')
      .join('/');
    if (!isScannablePath(relative)) continue;
    chunks.push(...extractChunks(relative, readFileSync(absolute, 'utf8'), options));
  }
  return chunks;
}

/**
 * The chunks in `before` that the same change's files no longer contain.
 *
 * Presence is substring-based, not equality-based, and that direction is
 * deliberate: copy folded into a longer sentence still renders, and Playwright's
 * default substring matching means the spec asserting the shorter run keeps
 * passing. Treating that as "still present" is what stops a rewrite that only
 * ADDS words from reading as a deletion.
 *
 * @param before - Chunks from the changed files at the base commit.
 * @param after - Chunks from those same files at HEAD. A move within the change
 *   is absorbed here, since both ends of it are changed files.
 */
export function removedChunks(before: Chunk[], after: Chunk[]): Chunk[] {
  const texts = after.map((chunk) => chunk.text);
  // Untouched copy is the overwhelming majority of any diff, and it survives
  // verbatim — so answer it by hash before falling back to the substring scan,
  // which is quadratic in the size of the changed files.
  const exact = new Set(texts);
  const seen = new Set<string>();
  const removed: Chunk[] = [];

  for (const chunk of before) {
    if (seen.has(chunk.text)) continue;
    seen.add(chunk.text);
    if (exact.has(chunk.text)) continue;
    if (texts.some((text) => text.includes(chunk.text))) continue;
    removed.push(chunk);
  }
  return removed;
}

/**
 * Which run contains which, or null when the two do not overlap usefully.
 *
 * The COPY side is tested first, so two runs that are equal after case-folding
 * — the settings-row shape, `Working Directory` against `/^working directory/i`
 * — classify as `removed-spans-assertion` and are ruled on directly, by asking
 * whether the changed files still render the spec's whole string. Classifying
 * that shape the other way is what made a pure Title-Case-to-sentence-case
 * rewrite report three findings against `/i` regexes it cannot possibly break.
 *
 * @param assertion - The apps/e2e string.
 * @param removed - The run the change deleted.
 * @param ignoreCase - Set when `assertion` came from a `/…/i` regex.
 */
export function classifyOverlap(
  assertion: string,
  removed: string,
  ignoreCase: boolean
): Overlap | null {
  if (spans(removed, assertion, ignoreCase)) {
    if (assertion.length / removed.length < MIN_ASSERTION_COVERAGE) return null;
    return 'removed-spans-assertion';
  }
  if (spans(assertion, removed, ignoreCase)) return 'assertion-spans-removed';
  return null;
}

/**
 * Pair every removed chunk with each browser-suite string that overlaps it, in
 * either direction.
 *
 * Deliberately separate from {@link dropSupported} so the corpus walk — the
 * only expensive step here — runs solely when this returns something.
 *
 * @param removed - Output of {@link removedChunks}.
 * @param specChunks - Chunks harvested from {@link SPEC_ROOTS}.
 */
export function matchSpecStrings(removed: Chunk[], specChunks: Chunk[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const chunk of removed) {
    for (const spec of specChunks) {
      const ignoreCase = spec.ignoreCase === true;
      const overlap = classifyOverlap(spec.text, chunk.text, ignoreCase);
      if (overlap === null) continue;
      const key = `${spec.file}:${spec.line}:${chunk.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        specFile: spec.file,
        specLine: spec.line,
        assertion: spec.text,
        ignoreCase,
        copyFile: chunk.file,
        copyLine: chunk.line,
        removed: chunk.text,
        overlap,
      });
    }
  }
  return findings;
}

/**
 * Drop findings whose spec string demonstrably still matches something at HEAD.
 *
 * The two overlap shapes admit different evidence, so each gets its own rule.
 *
 * `assertion-spans-removed` — the spec string is broader than any single chunk,
 * usually because it is interpolated, so nothing at HEAD can be checked against
 * it whole. The only honest question left is whether the copy GREW around the
 * run that vanished, and the answer is a HEAD run that is strictly longer than
 * the removed one, still inside the same spec string, AND containing the
 * removed run. All three clauses are load-bearing:
 *
 *   - drop "strictly longer" and `Connected —` in an unrelated component
 *     suppresses the MCP regression (the collision in the module doc);
 *   - drop "inside the spec string" and any long sentence anywhere suppresses
 *     everything;
 *   - drop "contains the removed run" and `TAKING_LONGER` — a longer, unchanged
 *     constant in the same file — suppresses #1549's presence break, which is
 *     exactly what happened (DOR-1819).
 *
 * `removed-spans-assertion` — here the spec string IS a complete run of copy,
 * so it can be checked directly: if the file the run left behind still holds a
 * chunk containing it, the locator still matches and there is nothing to
 * report. That covers both a pure casing sweep (`New Session` → `New session`,
 * which a `/new session/i` locator never noticed) and a long run splitting into
 * shorter ones around the fragment a spec quotes.
 *
 * Two narrowings, each measured on #1549:
 *
 *   - the CORPUS cannot be consulted here. The settings assertion the batch
 *     stranded asks for `working directory`, and thirty unrelated runs
 *     elsewhere in the tree still contain those words — none of them on the
 *     Server tab the spec drives.
 *   - nor can the other CHANGED FILES. `Select a working directory to browse
 *     its files.`, a file-explorer empty state in the same 190-file batch,
 *     vouches for that assertion just as wrongly. Scoping to the file the run
 *     left costs nothing, because {@link removedChunks} has already absorbed
 *     every cross-file move: a run that survives verbatim somewhere else in the
 *     change never counts as removed in the first place.
 *
 * @param findings - Output of {@link matchSpecStrings}.
 * @param corpusTexts - Every chunk text in the copy corpus at HEAD.
 * @param changedChunks - Chunks the changed files still hold at HEAD, with
 *   their paths, so a finding is answered by its OWN file.
 */
export function dropSupported(
  findings: Finding[],
  corpusTexts: string[],
  changedChunks: Chunk[] = []
): Finding[] {
  return findings.filter((finding) => {
    if (finding.overlap === 'removed-spans-assertion') {
      return !changedChunks.some(
        (chunk) =>
          chunk.file === finding.copyFile &&
          spans(chunk.text, finding.assertion, finding.ignoreCase)
      );
    }
    return !corpusTexts.some(
      (text) =>
        text.length > finding.removed.length &&
        spans(finding.assertion, text, finding.ignoreCase) &&
        text.includes(finding.removed)
    );
  });
}

/**
 * Keep one finding per stale assertion — the one whose removed run is closest
 * in length to the assertion, which is the most specific evidence available.
 *
 * A single locator can overlap several runs the same change removed: #1549's
 * `/^working directory/i` matched both the Server tab's `Working Directory` row
 * and `Select Working Directory`, a dialog title in a different file that the
 * same batch also reworded. Both are true, but the fix is one edit to one line,
 * and printing it twice reads as noise. Runs after {@link dropSupported} so a
 * suppressed candidate never displaces one that survived.
 *
 * @param findings - Surviving findings, in any order.
 */
export function collapseByPosition(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.specFile}:${finding.specLine}`;
    const held = best.get(key);
    const distance = Math.abs(finding.assertion.length - finding.removed.length);
    if (held === undefined || distance < Math.abs(held.assertion.length - held.removed.length)) {
      best.set(key, finding);
    }
  }
  return [...best.values()];
}

/**
 * Run the whole gate against a checkout.
 *
 * @param repoRoot - Checkout to inspect. The working tree is "after"; `baseRef`
 *   is "before".
 * @param baseRef - Commit-ish the change is measured against.
 */
export function runCopySpecGuard(repoRoot: string, baseRef: string): Finding[] {
  const changed = changedCopyFiles(repoRoot, baseRef);
  if (changed.length === 0) return [];

  const before: Chunk[] = [];
  const after: Chunk[] = [];
  for (const file of changed) {
    const contents = readAtRef(repoRoot, baseRef, file);
    // A file this change ADDED has no base version, so it removed nothing.
    if (contents !== null) before.push(...extractChunks(file, contents));
    const absolute = join(repoRoot, file);
    // ...and one it DELETED has no working-tree version, so it removed all of it.
    if (existsSync(absolute)) after.push(...extractChunks(file, readFileSync(absolute, 'utf8')));
  }
  if (before.length === 0) return [];

  const removed = removedChunks(before, after);
  if (removed.length === 0) return [];

  const candidates = matchSpecStrings(
    removed,
    collectCorpus(repoRoot, SPEC_ROOTS, { includeRegex: true })
  );
  if (candidates.length === 0) return [];

  // Only now is the whole-corpus walk worth its few seconds.
  return collapseByPosition(
    dropSupported(
      candidates,
      collectCorpus(repoRoot, COPY_ROOTS).map((chunk) => chunk.text),
      after
    )
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const baseRef = process.argv[2] ?? 'origin/main';
  const repoRoot = process.argv[3] ?? join(SCRIPT_DIR, '..');
  const findings = runCopySpecGuard(repoRoot, baseRef);

  if (findings.length > 0) {
    console.error(
      `check-copy-spec-drift: ${findings.length} browser-suite string(s) this change stranded:\n`
    );
    for (const finding of findings) {
      console.error(
        `::error file=${finding.specFile},line=${finding.specLine}::"${finding.assertion}" ` +
          `overlaps copy this change removed ("${finding.removed}", was ${finding.copyFile}:${finding.copyLine}) ` +
          `and no app source still produces it.`
      );
      console.error(`  ${finding.specFile}:${finding.specLine}  ${finding.assertion}`);
      console.error(`    removed: "${finding.removed}"`);
      console.error(`    was at:  ${finding.copyFile}:${finding.copyLine}\n`);
    }
    console.error(
      'Update the browser suite to the new copy in this same change. That is the fix in\n' +
        'nearly every case — the merge-queue shards would otherwise fail on it, and a queue\n' +
        'failure ejects the PR and disarms auto-merge (DOR-1647).\n\n' +
        'If the copy genuinely still renders — assembled somewhere this gate cannot read, or\n' +
        'produced outside apps/ and packages/shared — say so on the PR: this check is advisory\n' +
        'and does not block the merge queue.'
    );
    process.exit(1);
  }

  console.log(
    `check-copy-spec-drift: clean — no apps/e2e string depends on copy this change removed ` +
      `(base ${baseRef}).`
  );
}
