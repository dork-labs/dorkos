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
 * a spec string counts as a hit when it CONTAINS a removed chunk. Substring
 * containment is also what Playwright itself does: `getByText` matches on
 * substring unless `{ exact: true }` is passed.
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
}

/** A browser-suite string that spans copy this change removed. */
export interface Finding {
  /** Repo-relative path of the apps/e2e file holding the stale string. */
  specFile: string;
  /** 1-based line of that string. */
  specLine: number;
  /** The full apps/e2e string, normalized. */
  assertion: string;
  /** Repo-relative path the removed copy used to live at. */
  copyFile: string;
  /** 1-based line it used to live on. */
  copyLine: number;
  /** The removed chunk `assertion` still spans. */
  removed: string;
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

  function record(node: ts.Node, raw: string): void {
    const normalized = normalizeCopy(raw);
    if (!isProseChunk(normalized)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    chunks.push({ file, line: line + 1, text: normalized });
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
      const raw = node.getText(sourceFile);
      // Strip the delimiters and flags: `/Connected — 2 tools\./i` → `Connected
      // — 2 tools\.`. Backslash escapes inside survive, which costs nothing —
      // the chunks that matter carry no metacharacters.
      record(node, raw.slice(1, raw.lastIndexOf('/')));
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

/** A file's contents at `ref`, or null when it did not exist there. */
function readAtRef(repoRoot: string, ref: string, file: string): string | null {
  try {
    return git(repoRoot, ['show', `${ref}:${file}`]);
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
 * Pair every removed chunk with each browser-suite string that spans it.
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
      if (!spec.text.includes(chunk.text)) continue;
      const key = `${spec.file}:${spec.line}:${chunk.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        specFile: spec.file,
        specLine: spec.line,
        assertion: spec.text,
        copyFile: chunk.file,
        copyLine: chunk.line,
        removed: chunk.text,
      });
    }
  }
  return findings;
}

/**
 * Drop findings whose spec string is still covered, more specifically than the
 * removed run covered it, by copy that exists at HEAD.
 *
 * "More specifically" means strictly longer AND still contained in the same
 * spec string — the shape a rewrite takes when it only lengthens copy, or moves
 * it somewhere this change also touched. An equally-long match elsewhere in the
 * tree does NOT suppress: that is the `Connected —` collision the module doc
 * describes, where an unrelated component happens to hold the same eleven
 * characters and the spec still cannot match.
 *
 * @param findings - Output of {@link matchSpecStrings}.
 * @param corpusTexts - Every chunk text in the copy corpus at HEAD.
 */
export function dropSupported(findings: Finding[], corpusTexts: string[]): Finding[] {
  return findings.filter(
    (finding) =>
      !corpusTexts.some(
        (text) => text.length > finding.removed.length && finding.assertion.includes(text)
      )
  );
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
  return dropSupported(
    candidates,
    collectCorpus(repoRoot, COPY_ROOTS).map((chunk) => chunk.text)
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
          `spans copy this change removed ("${finding.removed}", was ${finding.copyFile}:${finding.copyLine}) ` +
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
