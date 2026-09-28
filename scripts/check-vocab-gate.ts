/**
 * Fail the build when retired vocabulary reappears in user-facing copy.
 *
 * WHY THIS EXISTS. DOR-855 spent a whole pass renaming every network-sense
 * "Connection" in the cockpit's copy so the word means one thing: the
 * Connections page. Nothing stops the next PR from typing "Connection failed"
 * into a new banner without knowing that word was reserved — a rename with no
 * guard rots the moment someone who didn't read the plan ships a string. This
 * script is that guard: it re-derives the same sweep DOR-855 did by hand and
 * runs it on every change instead of once.
 *
 * WHAT IT SCANS. `apps/client/src`, `apps/site/src`, and `apps/server/src` —
 * every workspace whose strings can reach a screen a DorkOS user reads,
 * including server-authored copy the client renders verbatim (a provisioning
 * error, an MCP tool title) — for TypeScript/TSX source, using the real
 * TypeScript parser rather than line-based grep. Grep cannot tell a quoted
 * user-facing string from the identifier `ConnectionState` or the import path
 * `./sse-connection`; both contain the word but neither is copy. The parser
 * lets this script check only positions that actually reach a screen:
 *
 *   - JSX text (`<p>Connection lost</p>`)
 *   - string/template literals in a JSX attribute the render path treats as
 *     copy (`label=`, `shortLabel=`, `title=`, `description=`, `message=`,
 *     `errorMessage=`, `text=`, `placeholder=`, `aria-label=`, `alt=`,
 *     `heading=`, `tagline=`, `tooltip=`)
 *   - string/template literals assigned to an object property with one of the
 *     same names (`{ label: 'Connection lost' }`, `{ message: '...' }`) — the
 *     attribute and property lists are kept identical on purpose, see
 *     {@link COPY_ATTR_NAMES}
 *   - the first argument to a `toast.*(...)` call or a call ending in
 *     `.setError(...)`
 *   - any of the above reached through a ternary, `??`/`||`/`&&` short-circuit,
 *     string concatenation (`+`), or parenthesization, so both
 *     `{isDown ? 'Connection lost' : ok}` and `{isDown && 'Connection lost'}`
 *     — the two idioms every conditional JSX-text render in this codebase
 *     actually uses — are caught
 *
 * Bare code — variable names, `case 'connection':` discriminants, object keys,
 * CSS classes, import specifiers — is invisible to this walk on purpose: those
 * are not copy, and flagging them would train everyone to ignore the gate.
 *
 * WHAT IT WON'T CATCH. `apps/client/src/dev/` (the component playground) is
 * excluded — it is a development tool, not a surface a DorkOS user reaches;
 * keeping its showcases in step with the copy they demonstrate is a manual
 * habit (the DOR-855 payment did it out of politeness, not because the gate
 * requires it), not something this script enforces. `__tests__/` directories
 * and `*.test.*` files are excluded too, since their fixtures echo arbitrary
 * strings (a mocked HTTP error, a test's own scenario label) that are not
 * this repo's authored copy.
 *
 * DOCS PROSE, SCANNED DIFFERENTLY (DOR-2508). `docs/**\/*.mdx` used to be
 * "prose, not a render path, swept by hand" — the connections-health audit
 * found the sweep had drifted (stale UI steps, a claim the threat model no
 * longer supported) with nothing to catch the next one. MDX is not
 * TypeScript, so it gets its own scan, {@link scanMdx}: a line-based pass
 * over {@link stripNonProse}'s output rather than a parser walk. Fenced code
 * blocks, inline code spans, markdown link targets (`](...)`) and `href`/`src`
 * JSX attribute values are blanked before matching, because a route like
 * `/docs/integrations/mcp-server` in a link target is not prose a reader
 * reads — only the link text is. Unlike {@link scanSource}, everything left
 * standing in an `.mdx` file after that strip counts as copy by default:
 * docs bodies are prose all the way down, the opposite assumption from
 * component source, where most text is non-copy identifiers. Two carve-outs
 * apply before the allowlist even runs: `docs/api/**` is generated from
 * `openapi.json` route descriptions (the same `provider` path parameters and
 * `connectors` path segments `check-banned-words.sh` already documented as
 * unswept wire naming), and `docs/changelog.mdx` / `docs/changelog-archive.mdx`
 * are compiled from `CHANGELOG.md`, which `AGENTS.md` forbids editing by hand
 * — both record what shipped or what the wire says, not new prose to sweep.
 * Everything else under `docs/` is scanned, but only against
 * {@link MDX_SCANNED_WAVES} — wave 4 ("integration"/"connector"/"adapter"/
 * "provider"), the exact vocabulary the audit swept docs for. Wave 1
 * ("connection", for network health) is deliberately NOT enforced in docs:
 * outside the Connections domain, "connection" is ordinary prose everywhere
 * a protocol or network guide talks about a network connection (the SSE
 * reference, tunnel setup, the reverse-proxy guide), and sweeping that is a
 * separate, unscoped effort this ticket did not take on. The same
 * `scripts/vocab-gate/allowlist.json` mechanism covers the wave-4 words that
 * survive for a real domain reason (the `/flow` engine's own tracker-adapter
 * pattern, OpenCode's model-provider picker, a marketplace package's
 * `adapter` facet, the software-testing sense of "integration test") — see
 * the allowlist file itself for the full audit trail. Unlike {@link scanSource},
 * `scanMdx` has NO inline marker for a docs exemption — see
 * {@link MDX_ALLOW_MARKER_BAN} for why one was tried and banned outright; the
 * only way to exempt a docs line is a scoped `allowlist.json` entry, narrowed
 * with {@link AllowlistEntry.contains} to the exact line it covers.
 *
 * A second unclosed gap, measured in DOR-1814: a string handed to an ordinary
 * function call is invisible, even when that call's return value lands in a
 * copy position. `plural(n, 'connection', 'connections')` inside a `label:`
 * template is the live example — the template itself is scanned, but the two
 * words that will actually be printed are arguments to `plural` and are not.
 * Same shape as `parts.push(\`... at a chat integration ...\`)`, where the
 * pushed sentence ends up in a `detail:`. Closing it means either whitelisting
 * copy-returning helpers by name or following the value, both bigger than the
 * classifier this file has; until then, a sweep of a file with helper-built
 * copy has to be read as well as scanned.
 *
 * A real, currently-unclosed gap: `return 'Connection lost'` and
 * `throw new Error('Connection lost')` are not copy-bearing positions this
 * script recognizes — a bare return or throw carries no property name or JSX
 * position to classify against, unlike `{ message: '...' }` or
 * `<p>{...}</p>`. Every server string DOR-855 actually renamed
 * (`honestInstallError`'s "Check your network", `OpenRouterError`'s "Could
 * not reach OpenRouter...") is exactly this shape, and none of them would be
 * re-caught by this script if the word crept back in. Solving that requires
 * either return-type-aware analysis (does this function's signature return
 * user-facing text?) or a call-site convention this repo doesn't have yet;
 * both are bigger than a wave-1 gate. Filed as a known limitation rather than
 * solved here — a future wave can add a narrower heuristic (e.g. functions
 * named `*ErrorMessage`/`honestInstallError`, or a `// vocab-gate: copy`
 * marker comment) without touching the mechanism this file already has.
 *
 * WHERE IT RUNS. The `typecheck` workflow, one step after
 * `check-banned-words.sh` — the two halves of the split above, side by side.
 * That is new as of DOR-1814. For its first four months this script's only CI
 * home was the real-repo canary inside `scripts/__tests__/check-vocab-gate.test.ts`,
 * run by `scripts-test.yml`'s `harness` job, which is scoped to `scripts/**` and
 * friends and does not run in the merge queue — so a PR touching nothing but
 * `apps/client/src` copy never ran the gate at all. The canary test stays: it
 * pins the mechanism, the workflow step enforces the result. The docs scan
 * (DOR-2508) rides the same step and the same canary — {@link runVocabGate}
 * runs both scans and returns one merged list, so a docs-only PR is checked by
 * the one `typecheck` step exactly like a source-only one, with no new
 * workflow step or job to keep required.
 *
 * DATA, NOT CODE, IS WHAT A NEW WAVE EXTENDS. `vocab-gate/banned-terms.json`
 * holds one wave per retired string (Wave 1: "connection"; Wave 2: "mission
 * control"/"cockpit"; Wave 3: the typography DOR-1756 settled — "...",
 * "&apos;", "&rsquo;", "&ldquo;", "&rdquo;"; Wave 4: "integration",
 * "connector", "adapter" and "provider", singular and plural, the four nouns
 * ADR 260804-021140 retired for "Connections"). Wave 4 is also the wave that
 * shows what the allowlist is FOR: all four words keep legitimate technical
 * senses this repo uses daily — `RelayAdapter`, `ConnectorProvider`, the
 * marketplace package types an author writes, OpenCode's model providers — and
 * every one of them is a scoped, reasoned entry rather than a term left
 * unbanned, because the word is correct only where the ADR's scoped-word
 * registry says it is. `vocab-gate/allowlist.json` holds
 * every legitimate domain use either scan still flags, each with a path
 * substring, an optional term scope, and a written reason. A new wave adds a
 * wave object and whatever allowlist entries its own sweep turns up — this file
 * does not change. Wave 3 is the one exception to date: banning punctuation
 * needed {@link termMatcher}, because the old inline `\b${term}\b` both treated
 * `.` as a wildcard and demanded a word boundary an ellipsis does not have. See
 * `scripts/__tests__/check-vocab-gate.test.ts`, the pin suite that keeps this
 * mechanism from rotting the way `assert-tests-executed.sh` is pinned by
 * `test-assert-tests-executed.sh`.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-vocab-gate.ts [repoRoot]
 *
 * With no argument it scans the repo this file lives in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `relative()`'s output with OS separators normalized to `/`, for portable path matching. */
function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

/** One retired word and the wave that retired it. */
export interface BannedTerm {
  /**
   * Matched case-insensitively; word-bounded on whichever ends are word
   * characters, so a punctuation term like `...` or `&quot;` matches wherever
   * it appears in a copy position rather than needing a word boundary it can
   * never have. See {@link termMatcher}.
   */
  term: string;
  /** Which wave banned it, for reporting. */
  wave: string;
  /** Tracker issue the wave shipped under. */
  issue: string;
}

/** A scoped exception: files at `path` may keep using some or all banned terms. */
export interface AllowlistEntry {
  /** Plain substring matched against the violation's repo-relative path. */
  path: string;
  /** Terms this entry covers. Absent means "every banned term". */
  terms?: string[];
  /**
   * Plain substring the violation's own snippet must ALSO contain, checked
   * case-sensitively against {@link Violation.snippet}. Absent means every
   * matching line at `path` is covered — the whole-file behavior every entry
   * had before this field existed. Present, it narrows a `path` match down to
   * the exact line(s) that legitimately need it: a real code identifier
   * (`'connectors.rawMcpServers'`) or a real page title (`title="Building
   * Relay Adapters"`), so a NEW, unrelated use of the same banned term
   * anywhere else in that file is still caught (DOR-2508, second review
   * round). Reserved for narrow, single-purpose entries — a directory or a
   * whole-page developer guide with dozens of legitimate uses throughout
   * (`docs/integrations/`, `docs/guides/flow/`) has no one line to name, and
   * stays path-only on purpose; see each such entry's own reason. For
   * `docs/**\/*.mdx`, a `contains`-scoped entry here is the ONLY way to exempt
   * one line — {@link MDX_ALLOW_MARKER_BAN} bans the inline-comment
   * alternative outright, because it leaks into the rendered page. `snippet`
   * is truncated to 140 characters (see {@link scanSource} and
   * {@link scanMdx}), so `contains` must match text within that window — a
   * substring from later in a long line never matches, silently, since a
   * missing match just means the violation stays reported rather than erring.
   */
  contains?: string;
  /** Why the usage is legitimate — required so the file stays an audit trail. */
  reason: string;
}

/** One place in the tree where a banned term reached a copy-bearing position. */
export interface Violation {
  file: string;
  line: number;
  column: number;
  term: string;
  wave: string;
  issue: string;
  snippet: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Workspaces that render product copy a DorkOS user reads. */
const DEFAULT_SCAN_ROOTS = ['apps/client/src', 'apps/site/src', 'apps/server/src'];

/** Path segments excluded outright — not scoped exceptions, just not copy. */
const EXCLUDED_SEGMENTS = [
  '/__tests__/',
  '/node_modules/',
  '/dist/',
  // The component playground: a development tool, not a surface a DorkOS user
  // reaches. See the module doc for why this is a hard exclusion rather than
  // an allowlist entry per showcase file.
  '/apps/client/src/dev/',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Docs prose roots scanned for retired vocabulary (DOR-2508). See the module doc. */
const DEFAULT_MDX_SCAN_ROOTS = ['docs'];

/**
 * Docs path segments excluded outright, the MDX-scan counterpart to
 * {@link EXCLUDED_SEGMENTS}. `docs/api/` is generated from `openapi.json`
 * route descriptions — wire naming, not authored prose (see the module doc).
 */
const MDX_EXCLUDED_SEGMENTS = ['/node_modules/', '/docs/api/'];

/**
 * Exact docs files excluded outright: both are compiled from `CHANGELOG.md`,
 * which `AGENTS.md` forbids editing by hand, so they keep their historical
 * wording exactly like the same two files already do for `check-banned-words.sh`.
 */
const MDX_EXCLUDED_FILES = new Set(['docs/changelog.mdx', 'docs/changelog-archive.mdx']);

const MDX_EXTENSIONS = new Set(['.mdx']);

/**
 * JSX attribute names whose value the render path treats as user copy. Kept in
 * sync with {@link COPY_PROP_NAMES} on purpose — a name that is copy as a
 * `<Foo label="..." />` attribute is copy as a `{ label: '...' }` object
 * property too, and the two lists drifting apart is exactly how
 * `errorMessage={...}` on `TestStep` went unscanned until review caught it.
 */
const COPY_ATTR_NAMES = new Set([
  'label',
  'shortLabel',
  'title',
  'description',
  'message',
  'errorMessage',
  'text',
  'placeholder',
  'aria-label',
  'alt',
  'heading',
  'tagline',
  'tooltip',
]);

/**
 * Object-property names whose value the render path treats as user copy. See
 * {@link COPY_ATTR_NAMES}.
 *
 * `q`/`a` are the compare-page FAQ shape (`{ q: string; a: string }[]` in
 * `apps/site/src/layers/features/marketing/lib/comparisons.ts`), rendered
 * verbatim by `ComparisonFaq`. A one-letter name is exactly as collision-prone
 * here as it would be as a JSX attribute — `{ a: 'Connection lost' }` scans as
 * a real violation today, same risk either way, so this is not a safety
 * argument. `q`/`a` are accepted as properties because a scan of the whole
 * tree finds zero false positives right now; they are left out of
 * {@link COPY_ATTR_NAMES} only because nothing needs them there yet. Add them
 * if a genuine `<Foo q="..." a="..." />` copy position ever shows up.
 */
const COPY_PROP_NAMES = new Set([
  'label',
  'shortLabel',
  'title',
  'description',
  'message',
  'errorMessage',
  'text',
  'heading',
  'tagline',
  'placeholder',
  'tooltip',
  'q',
  'a',
  // `detail` and `fix` are the other two thirds of a `CheckResult`
  // (apps/server/src/services/observability/deep-health/): `dorkos doctor`
  // prints all three — the label, the dimmed detail under it, and the fix line
  // that tells a person what to do. Only `label` was scanned until DOR-1814,
  // which is why that surface could carry "Fix the integration in Settings →
  // Integrations" — a retired word AND a Settings tab the rename deleted —
  // through two vocabulary waves without the gate seeing it. Left out of
  // {@link COPY_ATTR_NAMES} deliberately: neither is a JSX copy attribute in
  // this codebase, and a `fix=` prop would far more likely be a callback.
  'detail',
  'fix',
]);

/**
 * Load the banned-term list, flattened across waves.
 *
 * @param path - Path to `banned-terms.json`. Defaults to the file shipped
 *   beside this script.
 */
export function loadBannedTerms(
  path: string = join(SCRIPT_DIR, 'vocab-gate/banned-terms.json')
): BannedTerm[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    waves: { id: string; issue: string; terms: string[] }[];
  };
  return data.waves.flatMap((wave) =>
    wave.terms.map((term) => ({ term, wave: wave.id, issue: wave.issue }))
  );
}

/**
 * Load the allowlist.
 *
 * @param path - Path to `allowlist.json`. Defaults to the file shipped beside
 *   this script.
 */
export function loadAllowlist(
  path: string = join(SCRIPT_DIR, 'vocab-gate/allowlist.json')
): AllowlistEntry[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { entries: AllowlistEntry[] };
  return data.entries;
}

/**
 * Whether a violation at `filePath` for `term` is covered by an allowlist entry.
 *
 * @param filePath - Repo-relative path the violation was found at.
 * @param term - The banned term that matched.
 * @param allowlist - Entries to check against.
 * @param snippet - The violation's own snippet ({@link Violation.snippet}).
 *   Required to satisfy an entry that carries {@link AllowlistEntry.contains}
 *   — omit it only when every entry that could match `filePath` is path-only,
 *   e.g. a hermetic test fixture with no `contains` entries in play.
 */
export function isAllowlisted(
  filePath: string,
  term: string,
  allowlist: AllowlistEntry[],
  snippet?: string
): boolean {
  return allowlist.some(
    (entry) =>
      filePath.includes(entry.path) &&
      (entry.terms === undefined || entry.terms.includes(term)) &&
      (entry.contains === undefined || (snippet !== undefined && snippet.includes(entry.contains)))
  );
}

/**
 * Recursively collect files under `roots` whose extension is in `extensions`,
 * skipping any path containing a segment from `excludedSegments` or an exact
 * repo-relative path in `excludedFiles`. Shared by {@link collectFiles} and
 * {@link collectMdxFiles}, which differ only in which of those four sets they pass.
 */
function walkFiles(
  roots: string[],
  repoRoot: string,
  excludedSegments: string[],
  extensions: Set<string>,
  excludedFiles: Set<string> = new Set()
): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // A configured root that doesn't exist yet is not this script's problem.
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const relPath = toPosixRelative(repoRoot, full);
      const normalized = `/${relPath}/`;
      if (excludedSegments.some((seg) => normalized.includes(seg))) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.has(full.slice(full.lastIndexOf('.'))) && !excludedFiles.has(relPath)) {
        files.push(full);
      }
    }
  }

  for (const root of roots) walk(join(repoRoot, root));
  return files;
}

/** Recursively collect source files under `roots`, applying {@link EXCLUDED_SEGMENTS}. */
export function collectFiles(roots: string[], repoRoot: string): string[] {
  return walkFiles(roots, repoRoot, EXCLUDED_SEGMENTS, SOURCE_EXTENSIONS);
}

/**
 * Recursively collect `.mdx` docs files under `roots`, applying
 * {@link MDX_EXCLUDED_SEGMENTS} and {@link MDX_EXCLUDED_FILES} — the docs-prose
 * counterpart to {@link collectFiles}. See the module doc (DOR-2508).
 */
export function collectMdxFiles(roots: string[], repoRoot: string): string[] {
  return walkFiles(roots, repoRoot, MDX_EXCLUDED_SEGMENTS, MDX_EXTENSIONS, MDX_EXCLUDED_FILES);
}

/**
 * Walk up from a string/template literal through transparent wrappers
 * (parens, `??`/`||`/`+`, ternary branches) to find the position that decides
 * whether it is copy: a JSX attribute, JSX children, a named object property,
 * or a `toast.*`/`*.setError` call argument.
 *
 * @param node - The literal (or its enclosing wrapper) to classify.
 */
export function isCopySink(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (let hop = 0; hop < 12; hop++) {
    const parent = current.parent;
    if (!parent) return false;

    if (ts.isJsxAttribute(parent)) {
      // Exact case, not lower-cased: JSX preserves an attribute's authored
      // casing verbatim (`errorMessage`, `shortLabel`), so lower-casing here
      // would silently stop matching every camelCase entry in the set below —
      // 'aria-label' is the one native-DOM name we carry, and it is already
      // lowercase-hyphenated as written by convention.
      return COPY_ATTR_NAMES.has(parent.name.getText());
    }
    if (ts.isJsxExpression(parent)) {
      // A JsxExpression is either an attribute's `{...}` initializer (handled
      // one level up via its own JsxAttribute parent, so this branch would
      // only be reached for a bare `{expr}` in attribute position, which
      // falls through to false below) or a children-position `{expr}` — the
      // only case that reaches here after the attribute check above.
      return !ts.isJsxAttribute(parent.parent);
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      const name = ts.isPropertyAssignment(parent) ? parent.name.getText() : parent.name.getText();
      return COPY_PROP_NAMES.has(name.replace(/['"]/g, ''));
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === current) {
      const callee = parent.expression.getText();
      if (/\btoast\.(error|success|info|warning|message)\b/.test(callee)) return true;
      if (/\.setError$/.test(callee) || callee === 'setError') return true;
      return false;
    }
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        ['??', '||', '&&', '+'].includes(parent.operatorToken.getText()))
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Build the matcher for one banned term.
 *
 * The term is escaped, so a wave may ban punctuation (`...`, `&apos;`) and not
 * just words — an unescaped `.` matched any character, which is fine for
 * "connection" and wrong for an ellipsis. Word boundaries are added only at the
 * ends that have a word character to be a boundary of: `\bconnection\b` is what
 * keeps "reconnecting" clean, while `\b...\b` would never match anything.
 *
 * @param term - The banned term, as written in `banned-terms.json`.
 */
export function termMatcher(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(term) ? '\\b' : '';
  const tail = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${lead}${escaped}${tail}`, 'i');
}

/** Scan one already-read source file for banned-term hits in copy-bearing positions. */
export function scanSource(filePath: string, text: string, terms: BannedTerm[]): Violation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const matchers = terms.map((t) => ({ ...t, re: termMatcher(t.term) }));
  const violations: Violation[] = [];

  function record(node: ts.Node, raw: string): void {
    for (const m of matchers) {
      if (!m.re.test(raw)) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );
      violations.push({
        file: filePath,
        line: line + 1,
        column: character + 1,
        term: m.term,
        wave: m.wave,
        issue: m.issue,
        snippet: raw.trim().slice(0, 140),
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile);
      if (text.trim().length > 0) record(node, text);
    } else if (ts.isTemplateExpression(node)) {
      if (isCopySink(node)) {
        const raw = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
        record(node, raw);
      }
    } else if (ts.isStringLiteralLike(node)) {
      if (isCopySink(node)) record(node, node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Blank the inline-code spans (`` `...` ``), markdown link targets (the
 * `(...)` half of `[text](...)`), and `href=`/`src=` JSX attribute values on
 * one line that is not (or no longer) inside a fenced block. Shared by both
 * branches of {@link stripNonProse} that reach a real prose line: the whole
 * line when no fence touches it, and the leftover slices on either side of a
 * same-line fence pair (see {@link stripNonProse}'s Case A).
 *
 * @param segment - A line, or a slice of one, to blank code spans and link/attribute targets in.
 */
function stripInlineCodeAndTargets(segment: string): string {
  return segment
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/\]\(([^)]*)\)/g, (_m, url: string) => `](${' '.repeat(url.length)})`)
    .replace(
      /(href|src)=(["'])([^"']*)\2/g,
      (_m, attr: string, quote: string, value: string) =>
        `${attr}=${quote}${' '.repeat(value.length)}${quote}`
    );
}

/**
 * Blank out the parts of an `.mdx` file that are not prose a docs reader
 * reads, line by line so every remaining line keeps its original number.
 *
 * FENCES. A fenced code block (` ``` `/`~~~`) is tracked by a small state
 * machine, because Prettier's MDX formatter routinely collapses a short
 * fenced block onto one line inside a JSX child (`<Tab value="…">```bash
 * pnpm test ``` Runs all tests in watch mode.</Tab>`, `docs/contributing/
 * testing.mdx`). Two rules, checked in this order on every line not already
 * inside a fence:
 *
 *   1. **A fence that opens AND closes on the same line is inline code**, not
 *      a state change — found by scanning the line for every run of 3+
 *      backticks or 3+ tildes and pairing the first with the next run of the
 *      SAME character whose length is at least the first's (CommonMark: a
 *      fence only closes on its own character, at its own length or longer —
 *      a 4-backtick opener is not closed by a 3-backtick line inside it, the
 *      other shape this rule has to get right). Only the matched span is
 *      blanked; whatever sits before or after it on that line — `<Tab
 *      value="All tests">`, `Runs all tests in watch mode.` — is real prose
 *      and is still scanned, via {@link stripInlineCodeAndTargets}.
 *   2. Otherwise, a line whose first non-whitespace characters are a run of
 *      3+ backticks or tildes opens a real multi-line fence: record its
 *      character and length, and blank the rest of the line.
 *
 * Once inside a fence, every line is blanked outright, and the fence closes
 * only on a line that, after leading whitespace, is NOTHING BUT a run of the
 * SAME character at least as long as the opener — anchored to the start of
 * the line and required to run to the end of it, per CommonMark. Never a
 * shorter run of the same character (the nested-fence case above), never the
 * other character, and never a run that merely ends a line of real content or
 * sits in the middle of one (a shell script echoing `` ``` `` is content, not
 * a closer). Verified against the real compiler, not assumed: compiling
 * `docs/self-hosting/deployment.mdx`'s original closer-trails-content line
 * through `@mdx-js/mdx` directly confirmed it did NOT close there either — a
 * real, pre-existing site bug (the "Interactive Setup" tab never rendered; it
 * was absorbed into the wrong code block), fixed directly in that file
 * alongside this rule, which anchors the way it does — rather than the looser
 * "anywhere on the line" check an earlier, unverified version of this file
 * shipped — precisely so a shape like it is recognized as still
 * open rather than silently accepted as closed anywhere else in `docs/`.
 *
 * EVERYTHING ELSE. Inline code spans (`` `...` ``), markdown link targets
 * (the `(...)` half of `[text](...)`), and `href=`/`src=` JSX attribute
 * values are blanked wherever they appear on a non-fenced line or slice — a
 * route like `/docs/integrations/mcp-server` inside a link target is never
 * prose a reader reads, only the link text beside it is. Import/export lines
 * (MDX component imports) are blanked outright, the same reasoning as
 * {@link isCopySink} ignoring an import specifier in source. Everything left
 * standing after that counts as copy: unlike component source, a docs body
 * is prose all the way down, so this strips only what is provably code or a
 * link/attribute target rather than allow-listing what counts as copy.
 *
 * @param text - The raw `.mdx` file contents.
 */
export function stripNonProse(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  return lines
    .map((line) => {
      if (/^\s*(import|export)\s/.test(line)) return '';

      if (inFence) {
        // A closer must be ALONE on its line, per CommonMark: leading
        // whitespace, then a run of the fence character at least as long as
        // the opener, then nothing but trailing whitespace. Anchored to
        // `^\s*`, not searched anywhere in the line — a mid-line ``` inside
        // real code content (a shell script echoing markdown, say) is
        // content, never a closer, and neither is a shorter same-character
        // run (the nested-fence case) even when it does start the line.
        // Verified against the real MDX compiler, not assumed: compiling
        // `docs/self-hosting/deployment.mdx`'s ORIGINAL "```content" ending —
        // a run of the fence character trailing real content, not alone on
        // its line — confirmed the real compiler treats it as literal code
        // text too, exactly what this anchored check now also does. That
        // file had this exact shape and shipped broken because of it (fixed
        // directly, same change that added this check).
        if (new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`).test(line)) inFence = false;
        return '';
      }

      // Case 1: every run of 3+ backticks or tildes on this line, in order.
      const markers: { index: number; char: string; length: number }[] = [];
      const markerRe = /`{3,}|~{3,}/g;
      let markerMatch: RegExpExecArray | null;
      while ((markerMatch = markerRe.exec(line)) !== null) {
        markers.push({
          index: markerMatch.index,
          char: markerMatch[0]!.charAt(0),
          length: markerMatch[0]!.length,
        });
      }
      if (markers.length >= 2) {
        const opener = markers[0]!;
        const closer = markers
          .slice(1)
          .find((cand) => cand.char === opener.char && cand.length >= opener.length);
        if (closer) {
          const closerEnd = closer.index + closer.length;
          const before = stripInlineCodeAndTargets(line.slice(0, opener.index));
          const after = stripInlineCodeAndTargets(line.slice(closerEnd));
          return before + ' '.repeat(closerEnd - opener.index) + after;
        }
      }

      // Case 2: this line opens a real multi-line fence.
      const openMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (openMatch) {
        const marker = openMatch[1]!;
        inFence = true;
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        return '';
      }

      return stripInlineCodeAndTargets(line);
    })
    .join('\n');
}

/**
 * An inline JSX-comment marker wrapping the text `vocab-allow: reason` — the convention
 * `check-banned-words.sh` uses for its own, unrelated wave-2 ban — was tried
 * in `.mdx` prose for wave 4 (DOR-2508) and reverted: Fumadocs' remark
 * pipeline does not treat a JSX comment as invisible the way a browser does.
 * `remarkHeading` copies a heading's inline children, comment included, into
 * the sidebar table-of-contents title AND the anchor slug it generates from
 * that title; `remarkStructure` does the same into the page's search index
 * entry for the paragraph it sits in. A marker meant to be read only by this
 * script and a future editor ends up as visible, malformed text on the live
 * site instead — confirmed against Fumadocs' own plugins, not assumed, after
 * the JSX-comment marker had already shipped and been caught doing exactly
 * that in `docs/concepts/relay.mdx`, `docs/guides/relay-messaging.mdx`,
 * `docs/guides/workspaces.mdx` and `docs/marketplace/index.mdx`. There is no
 * position in a docs page a JSX comment is provably safe in: a heading, list
 * item or paragraph can all be titles, anchors or search text depending on
 * where Fumadocs' plugins choose to look, and that set is not part of this
 * script's contract with them. `docs/**\/*.mdx` therefore has no marker
 * mechanism at all — {@link MDX_ALLOW_MARKER_BAN} makes the string
 * `vocab-allow` itself a hard violation inside `docs/`, so the convention
 * cannot quietly return. The scoped exemption a docs violation needs is a
 * `contains`-scoped `allowlist.json` entry instead (see
 * {@link AllowlistEntry.contains}), which lives in a file the site never
 * renders.
 */
const MDX_ALLOW_MARKER_BAN = 'vocab-allow';

/**
 * Scan one already-read `.mdx` docs file for banned-term hits in prose, after
 * {@link stripNonProse} removes code and link/attribute targets. A line-based
 * regex scan rather than {@link scanSource}'s parser walk, because MDX is not
 * TypeScript — see the module doc (DOR-2508) for why that is the right tool
 * here and what it can't tell apart from real prose. Independently of any
 * banned term, a line containing the substring {@link MDX_ALLOW_MARKER_BAN}
 * is ALWAYS reported — see that constant's doc for why an inline marker is
 * never safe in a docs page, whatever it's exempting.
 *
 * @param filePath - Repo-relative path, used only to label violations.
 * @param text - The raw `.mdx` file contents.
 * @param terms - Banned terms to match, as loaded by {@link loadBannedTerms}.
 */
export function scanMdx(filePath: string, text: string, terms: BannedTerm[]): Violation[] {
  const stripped = stripNonProse(text).split('\n');
  const rawLines = text.split('\n');
  const matchers = terms.map((t) => ({ ...t, re: new RegExp(termMatcher(t.term).source, 'gi') }));
  const violations: Violation[] = [];

  rawLines.forEach((rawLine, index) => {
    const markerColumn = rawLine.indexOf(MDX_ALLOW_MARKER_BAN);
    if (markerColumn === -1) return;
    violations.push({
      file: filePath,
      line: index + 1,
      column: markerColumn + 1,
      term: MDX_ALLOW_MARKER_BAN,
      wave: 'docs-marker-ban',
      issue: 'DOR-2508',
      snippet: rawLine.trim().slice(0, 140),
    });
  });

  stripped.forEach((line, index) => {
    for (const m of matchers) {
      m.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = m.re.exec(line)) !== null) {
        violations.push({
          file: filePath,
          line: index + 1,
          column: match.index + 1,
          term: m.term,
          wave: m.wave,
          issue: m.issue,
          snippet: rawLines[index]!.trim().slice(0, 140),
        });
        if (match[0].length === 0) m.re.lastIndex += 1; // guard a zero-length match from looping forever
      }
    }
  });

  return violations;
}

/**
 * The waves the docs scan enforces. Wave 4 ("integration"/"connector"/
 * "adapter"/"provider") is exactly what DOR-2508's connections-health audit
 * swept docs for and what the ADR retired as user-facing nouns — the wave
 * this docs scan exists to guard. Waves 1 and 3 ("connection" for network
 * health, and house typography) are source-only here on purpose: docs prose
 * outside the Connections domain uses "connection" in its ordinary network
 * sense constantly (the SSE protocol reference, tunnel and reverse-proxy
 * guides), a sweep nobody has done and this ticket did not ask for — adding
 * it would mean re-litigating dozens of lines with no domain reason to flag
 * them, not extending the guard DOR-2508 was scoped to. Wave 2 (mission
 * control/cockpit) already has a docs-prose guard, `check-banned-words.sh`,
 * predating this one. A future ticket can widen `MDX_SCANNED_WAVES`
 * deliberately, the same way a new wave object is added to
 * `banned-terms.json` — this is data, not a hardcoded exception.
 */
const MDX_SCANNED_WAVES = new Set(['wave-4']);

/**
 * Run the gate against a repo checkout: TypeScript/TSX source through
 * {@link scanSource} against every wave, and `.mdx` docs prose through
 * {@link scanMdx} (DOR-2508) against {@link MDX_SCANNED_WAVES} only, merged
 * into one violation list so one CI step covers both.
 *
 * @param repoRoot - Repo root to scan from. Defaults to the current working directory.
 * @param scanRoots - Workspace-relative source roots to scan. Defaults to {@link DEFAULT_SCAN_ROOTS}.
 * @param docsRoots - Workspace-relative docs roots to scan. Defaults to {@link DEFAULT_MDX_SCAN_ROOTS}.
 */
export function runVocabGate(
  repoRoot: string = process.cwd(),
  scanRoots: string[] = DEFAULT_SCAN_ROOTS,
  docsRoots: string[] = DEFAULT_MDX_SCAN_ROOTS
): Violation[] {
  const terms = loadBannedTerms();
  const docsTerms = terms.filter((t) => MDX_SCANNED_WAVES.has(t.wave));
  const allowlist = loadAllowlist();
  const violations: Violation[] = [];

  for (const file of collectFiles(scanRoots, repoRoot)) {
    const relPath = toPosixRelative(repoRoot, file);
    const text = readFileSync(file, 'utf8');
    for (const v of scanSource(relPath, text, terms)) {
      if (isAllowlisted(v.file, v.term, allowlist, v.snippet)) continue;
      violations.push(v);
    }
  }

  for (const file of collectMdxFiles(docsRoots, repoRoot)) {
    const relPath = toPosixRelative(repoRoot, file);
    const text = readFileSync(file, 'utf8');
    for (const v of scanMdx(relPath, text, docsTerms)) {
      // The marker ban is deliberately not allowlistable — an `allowlist.json`
      // entry that omitted `terms` would otherwise cover every term at its
      // path, this one included, quietly reopening the exact leak the ban
      // exists to close. See MDX_ALLOW_MARKER_BAN's doc.
      if (v.wave !== 'docs-marker-ban' && isAllowlisted(v.file, v.term, allowlist, v.snippet)) {
        continue;
      }
      violations.push(v);
    }
  }

  return violations;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = process.argv[2] ?? join(SCRIPT_DIR, '..');
  const violations = runVocabGate(repoRoot);

  if (violations.length > 0) {
    console.error(`check-vocab-gate: ${violations.length} retired-vocabulary hit(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}  "${v.term}" (${v.wave}, ${v.issue})`);
      console.error(`    ${v.snippet}`);
    }
    console.error(
      '\nRewrite the copy: drop the retired word, or spell the mark the house way ' +
        '(… ’ “ ”, never ... or &apos;). If the use is genuinely legitimate — a real ' +
        'Connections-domain noun, GitHub\'s own "Mission Control", a code sample — add ' +
        'a scoped entry with a reason to scripts/vocab-gate/allowlist.json.'
    );
    if (violations.some((v) => v.wave === 'docs-marker-ban')) {
      console.error(
        '\nA "vocab-allow" hit above is a docs/**/*.mdx marker, banned outright: it leaks ' +
          "into the live page's heading titles, anchors and search text through Fumadocs' " +
          'own remark plugins. Remove the inline comment and add a `contains`-scoped entry ' +
          'to scripts/vocab-gate/allowlist.json instead — see AllowlistEntry.contains.'
      );
    }
    process.exit(1);
  }

  console.log(
    `check-vocab-gate: clean — 0 hits across ${[...DEFAULT_SCAN_ROOTS, ...DEFAULT_MDX_SCAN_ROOTS].join(', ')}.`
  );
}
