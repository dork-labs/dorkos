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
 * this repo's authored copy. `docs/` (Fumadocs MDX) is out of scope for the
 * same reason the DOR-855 payment left it out of the known-sites list: it is
 * prose, not a render path, and gets swept by hand alongside the UI strings
 * it describes.
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
 * DATA, NOT CODE, IS WHAT WAVE 2 EXTENDS. `vocab-gate/banned-terms.json` holds
 * one wave per retired word (Wave 1: "connection"); `vocab-gate/allowlist.json`
 * holds every legitimate domain use the parser still flags, each with a path
 * substring, an optional term scope, and a written reason. Wave 2 (plan:
 * integration, connector, adapter, provider, platform-channel) adds a wave
 * object and whatever allowlist entries its own sweep turns up — this file
 * does not change. See `scripts/__tests__/check-vocab-gate.test.ts`, the pin
 * suite that keeps this mechanism from rotting the way `assert-tests-executed.sh`
 * is pinned by `test-assert-tests-executed.sh`.
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
  /** Matched as a whole word, case-insensitive. */
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

/** Recursively collect source files under `roots`, applying {@link EXCLUDED_SEGMENTS}. */
export function collectFiles(roots: string[], repoRoot: string): string[] {
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
      const normalized = `/${toPosixRelative(repoRoot, full)}/`;
      if (EXCLUDED_SEGMENTS.some((seg) => normalized.includes(seg))) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
        files.push(full);
      }
    }
  }

  for (const root of roots) walk(join(repoRoot, root));
  return files;
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

/** Scan one already-read source file for banned-term hits in copy-bearing positions. */
export function scanSource(filePath: string, text: string, terms: BannedTerm[]): Violation[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const matchers = terms.map((t) => ({ ...t, re: new RegExp(`\\b${t.term}\\b`, 'i') }));
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
 * Run the gate against a repo checkout.
 *
 * @param repoRoot - Repo root to scan from. Defaults to the current working directory.
 * @param scanRoots - Workspace-relative roots to scan. Defaults to {@link DEFAULT_SCAN_ROOTS}.
 */
export function runVocabGate(
  repoRoot: string = process.cwd(),
  scanRoots: string[] = DEFAULT_SCAN_ROOTS
): Violation[] {
  const terms = loadBannedTerms();
  const allowlist = loadAllowlist();
  const files = collectFiles(scanRoots, repoRoot);
  const violations: Violation[] = [];

  for (const file of files) {
    const relPath = toPosixRelative(repoRoot, file);
    const text = readFileSync(file, 'utf8');
    for (const v of scanSource(relPath, text, terms)) {
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
      '\nRewrite the copy to drop the retired word, or — if this use is genuinely ' +
        'Connections-domain — add a scoped entry with a reason to scripts/vocab-gate/allowlist.json.'
    );
    process.exit(1);
  }

  console.log(`check-vocab-gate: clean — 0 hits across ${DEFAULT_SCAN_ROOTS.join(', ')}.`);
}
