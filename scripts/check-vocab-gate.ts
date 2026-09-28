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
 * the allowlist file itself for the full audit trail.
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
 */
export function isAllowlisted(
  filePath: string,
  term: string,
  allowlist: AllowlistEntry[]
): boolean {
  return allowlist.some(
    (entry) =>
      filePath.includes(entry.path) && (entry.terms === undefined || entry.terms.includes(term))
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
 * Blank out the parts of an `.mdx` file that are not prose a docs reader
 * reads, line by line so every remaining line keeps its original number:
 * fenced code blocks (` ``` `/`~~~`, tracked by a small state machine since a
 * closing fence must match its opener), inline code spans (`` `...` ``),
 * markdown link targets (the `(...)` half of `[text](...)`), and `href=`/`src=`
 * JSX attribute values. A route like `/docs/integrations/mcp-server` inside a
 * link target is never prose — only the link text beside it is — so leaving
 * targets in would flag a URL nobody reads as a sentence. Import/export lines
 * (MDX component imports) are blanked outright, the same reasoning as
 * {@link isCopySink} ignoring an import specifier in source. Everything a line
 * has left after that counts as copy: unlike component source, a docs body is
 * prose all the way down, so this strips only what is provably code or a
 * link/attribute target rather than allow-listing what counts as copy.
 *
 * @param text - The raw `.mdx` file contents.
 */
export function stripNonProse(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';

  return lines
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const char = fenceMatch[1]!.charAt(0);
        if (!inFence) {
          inFence = true;
          fenceChar = char;
        } else if (char === fenceChar) {
          inFence = false;
        }
        return '';
      }
      if (inFence) return '';
      if (/^\s*(import|export)\s/.test(line)) return '';

      return line
        .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
        .replace(/\]\(([^)]*)\)/g, (_m, url: string) => `](${' '.repeat(url.length)})`)
        .replace(
          /(href|src)=(["'])([^"']*)\2/g,
          (_m, attr: string, quote: string, value: string) =>
            `${attr}=${quote}${' '.repeat(value.length)}${quote}`
        );
    })
    .join('\n');
}

/**
 * Scan one already-read `.mdx` docs file for banned-term hits in prose, after
 * {@link stripNonProse} removes code and link/attribute targets. A line-based
 * regex scan rather than {@link scanSource}'s parser walk, because MDX is not
 * TypeScript — see the module doc (DOR-2508) for why that is the right tool
 * here and what it can't tell apart from real prose.
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
      if (isAllowlisted(v.file, v.term, allowlist)) continue;
      violations.push(v);
    }
  }

  for (const file of collectMdxFiles(docsRoots, repoRoot)) {
    const relPath = toPosixRelative(repoRoot, file);
    const text = readFileSync(file, 'utf8');
    for (const v of scanMdx(relPath, text, docsTerms)) {
      if (isAllowlisted(v.file, v.term, allowlist)) continue;
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
    process.exit(1);
  }

  console.log(
    `check-vocab-gate: clean — 0 hits across ${[...DEFAULT_SCAN_ROOTS, ...DEFAULT_MDX_SCAN_ROOTS].join(', ')}.`
  );
}
