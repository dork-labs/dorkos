#!/usr/bin/env node
/**
 * Decide whether a change only rewrites text: string contents, comments and
 * Markdown. When it does, the test shards and the browser suites stand down
 * and a narrow lane runs instead (DOR-4834).
 *
 * WHY THIS EXISTS. DOR-4833 changed the company's address: one string in
 * packages/shared/src/company.ts and the tests that assert it. Every package
 * imports @dorkos/shared, so the pull request and its queue build ran nearly the
 * whole suite, about an hour of runner time, for a change no test outside the
 * three files it touched could see. scripts/no-code-scope.sh already skips
 * prose-only paths; this answers the next question, file by file and
 * machine-checked: is the code itself unchanged?
 *
 * WHAT COUNTS AS TEXT ONLY. Every changed path must pass {@link pathRefusal},
 * and every changed .ts/.tsx/.js/.mjs file must parse, on both sides, to the
 * same TypeScript syntax tree token for token, except inside:
 *
 *   string literals and the static parts of template literals (`${}` holes
 *   are code), and JSX text            -- see {@link literalRefusal}
 *   comments, JSDoc included           -- trivia, so they never reach the walk
 *   whitespace and quote style         -- formatting, same tokens
 *
 * A changed string still counts as code when it sits where code reads it (a
 * module specifier, a property name, a type, a `case`, one side of a
 * comparison, a directive, a tagged template, a decorator, or any JSX attribute
 * but `aria-label`, `aria-description`, `title`, `alt` and `placeholder`), or
 * when either side looks like a URL, a path, a permission or scope name, an
 * identifier, a shell command, or its placeholders changed.
 *
 * WHAT THE LANE RUNS INSTEAD, from the outputs below. test.yml runs
 * `vitest related` over `vitest_files`: every changed code and Markdown file,
 * and every test file at the head that quotes a changed string's OLD text or a
 * changed Markdown file's name. browser-test.yml runs the specs in `specs`,
 * the browser specs that quote an old string (the DOR-1647 class: apps/e2e
 * asserts literal copy). typecheck and lint run as always.
 *
 * FAILS CLOSED. Anything it cannot decide is "not text only": wrong arguments,
 * a revision git cannot resolve, an empty diff, a file that does not parse, a
 * missing TypeScript, any thrown error. Not text only means every suite runs,
 * exactly as before this script existed.
 *
 * THE PR CANNOT GRADE ITSELF. The workflows run this file, and the security
 * list it reads, as they stand on the BASE commit (the same guard as
 * no-code-scope.sh, Security #3238). The security list is not copied here: it
 * is read from security-gate.yml through .github/scripts/security-gate.mjs.
 *
 * Usage:
 *   node scripts/text-only-scope.mjs <base-sha> <head-sha>
 *
 * Prints GitHub step outputs, one per line, and exits 0:
 *   text_only=true|false
 *   reason=<one line>
 *   vitest_files=<JSON array of repo paths>
 *   browser=none|specs|full
 *   specs=<JSON array of spec paths relative to apps/e2e>
 *
 * Pinned by scripts/__tests__/text-only-scope.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { securityPathPattern, touchesSecurity } from '../.github/scripts/security-gate.mjs';

const CODE_FILE = /\.(ts|tsx|js|mjs)$/;
const PROSE_FILE = /\.md$/;
// Past these, a change's old text is too common to name a few tests or specs
// (a "," or an "s" quotes everywhere), and the lane would be the whole suite
// on one runner. The full suite on its usual shards is faster, so it runs.
const MAX_TESTS = 60;
const MAX_SPECS = 12;

/** The JSX attributes whose plain string value is copy. Any other is code. */
export const COPY_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'title',
  'alt',
  'placeholder',
]);

/** Why `path` can never be text only, or null. `status` is git's A, M or D. */
export function pathRefusal(path, status, pattern) {
  const name = path.split('/').pop();
  if (touchesSecurity([{ filename: path }], pattern)) return `${path} is a security path`;
  if (path.startsWith('.github/')) return `${path} is CI configuration`;
  if (path.startsWith('scripts/')) return `${path} is CI tooling`;
  if (/^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(name))
    return `${path} is a lockfile`;
  if (/(^|\/)(migrations|drizzle)\//.test(path)) return `${path} is a migration`;
  if (/^(package\.json|turbo\.json)$|^tsconfig|\.config\.|^\.env/.test(name))
    return `${path} is configuration`;
  // A new Markdown file is prose (a changelog fragment, most often); a deleted
  // one may be a file something reads.
  if (PROSE_FILE.test(path)) return status === 'D' ? `${path} was deleted` : null;
  if (!CODE_FILE.test(path) || path.endsWith('.d.ts'))
    return `${path} is not a .ts, .tsx, .js, .mjs or .md file`;
  if (status !== 'M') return `${path} was ${status === 'A' ? 'added' : 'deleted'}`;
  return null;
}

const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|^\/\/|^(mailto|tel|data|javascript):|www\./i;
const COMMAND_LIKE =
  /^(sudo|npm|npx|pnpm|yarn|bun|node|tsx|turbo|vitest|playwright|git|gh|bash|sh|zsh|curl|wget|rm|cp|mv|mkdir|chmod|chown|docker|brew|cd|echo|export|cat|claude|dorkos)(\s|$)|&&|\|\||\$\(|`|\s\|\s|(^|\s)--?[a-z][\w-]*(=|\s|$)|2>&1/;

/** The interpolation holes a string carries, so a rewrite cannot drop or rename one. */
function holes(text) {
  return (text.match(/\{\{?\s*[\w.]+\s*\}?\}|%[sdifoj]|\$\d+/g) ?? []).sort().join('\0');
}

/** Why one side of a changed literal reads as code rather than copy, or null. */
export function valueRefusal(value, { jsxText = false } = {}) {
  const v = value.trim();
  if (!v) return jsxText ? null : 'it is empty or blank';
  if (URL_LIKE.test(v)) return `"${v}" looks like a URL`;
  if (!/\s/.test(v) && /[/\\]/.test(v)) return `"${v}" looks like a path`;
  if (!/\s/.test(v) && /^[\w@$*-]+([:.][\w@$*-]+)+$/.test(v))
    return `"${v}" looks like a permission, scope or dotted name`;
  if (!jsxText && (/^[a-z_$][\w$-]*$/.test(v) || /^[A-Z][A-Z0-9_]+$/.test(v)))
    return `"${v}" looks like an identifier or an enum value`;
  if (COMMAND_LIKE.test(v)) return `"${v}" looks like a shell command`;
  return null;
}

const COMPARISON = [
  'EqualsEqualsToken',
  'EqualsEqualsEqualsToken',
  'ExclamationEqualsToken',
  'ExclamationEqualsEqualsToken',
  'LessThanToken',
  'LessThanEqualsToken',
  'GreaterThanToken',
  'GreaterThanEqualsToken',
  'InKeyword',
  'InstanceOfKeyword',
];

/** Why a changed literal sits where code reads it, or null when it is copy. */
export function literalRefusal(ts, node) {
  const p = node.parent;
  if (node.kind !== ts.SyntaxKind.JsxText) {
    if (p.name === node || p.propertyName === node || ts.isComputedPropertyName(p))
      return 'a property or binding name changed';
    if (
      ts.isImportDeclaration(p) ||
      ts.isExportDeclaration(p) ||
      ts.isExternalModuleReference(p) ||
      ts.isImportAttribute(p) ||
      (ts.isCallExpression(p) &&
        (p.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(p.expression) && p.expression.text === 'require')))
    )
      return 'a module specifier changed';
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node)
      return 'an element access key changed';
    if (ts.isCaseClause(p)) return 'a case label changed';
    if (
      ts.isBinaryExpression(p) &&
      COMPARISON.some((name) => ts.SyntaxKind[name] === p.operatorToken.kind)
    )
      return 'one side of a comparison changed';
    if (ts.isExpressionStatement(p)) return 'a directive or bare string statement changed';
  }
  for (let n = p; n; n = n.parent) {
    if (ts.isTaggedTemplateExpression(n)) return 'a tagged template changed';
    if (ts.isDecorator(n)) return 'a decorator argument changed';
    if (ts.isTypeNode(n)) return 'a type changed';
    if (ts.isJsxSpreadAttribute(n)) return 'a JSX spread attribute changed';
    if (ts.isJsxAttribute(n)) {
      const name = n.name.getText();
      if (n !== p || !COPY_ATTRIBUTES.has(name)) return `the JSX attribute ${name} is code`;
    }
  }
  return null;
}

const jsxNormal = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Compare one file's two versions. Returns `{ refusal }` or `{ changes }`, each
 * change the old and new text of one literal.
 */
export function compareSource(ts, path, before, after) {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const a = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true, kind);
  const b = ts.createSourceFile(path, after, ts.ScriptTarget.Latest, true, kind);
  // `parseDiagnostics` is the parser's own error list. If a TypeScript release
  // ever drops it, nothing can be shown to parse, so nothing qualifies.
  for (const sf of [a, b])
    if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length > 0)
      return { refusal: `${path} does not parse cleanly` };
  const TEXT = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const kids = (n, sf) =>
    n
      .getChildren(sf)
      .filter((c) => c.kind < ts.SyntaxKind.FirstJSDocNode || c.kind > ts.SyntaxKind.LastJSDocNode);
  const at = (n) => `${path}:${a.getLineAndCharacterOfPosition(n.getStart(a)).line + 1}`;
  const tokenName = (k) =>
    k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier
      ? 'an identifier'
      : k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.BigIntLiteral
        ? 'a number'
        : k === ts.SyntaxKind.RegularExpressionLiteral
          ? 'a regular expression'
          : 'a token';
  const changes = [];

  function walk(x, y) {
    if (x.kind !== y.kind) return `${at(x)}: the code changed`;
    const xs = kids(x, a);
    const ys = kids(y, b);
    if (xs.length !== ys.length) return `${at(x)}: the code changed`;
    if (xs.length === 0) {
      if (x.getText(a) === y.getText(b)) return null;
      if (!TEXT.has(x.kind)) return `${at(x)}: ${tokenName(x.kind)} changed`;
      const jsxText = x.kind === ts.SyntaxKind.JsxText;
      const old = jsxText ? jsxNormal(x.text) : x.text;
      const now = jsxText ? jsxNormal(y.text) : y.text;
      if (old === now) return null;
      const why =
        literalRefusal(ts, x) ??
        valueRefusal(old, { jsxText }) ??
        valueRefusal(now, { jsxText }) ??
        (holes(old) !== holes(now) ? 'its placeholders changed' : null);
      if (why) return `${at(x)}: ${why}`;
      changes.push({ path, old, now });
      return null;
    }
    for (let i = 0; i < xs.length; i++) {
      const why = walk(xs[i], ys[i]);
      if (why) return why;
    }
    return null;
  }
  const refusal = walk(a, b);
  return refusal ? { refusal } : { changes };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** `git grep -F -l` at `rev` for any of `patterns`, as repo paths. No match is []. */
function grepFiles(rev, patterns, pathspecs, cwd) {
  if (patterns.length === 0) return [];
  try {
    const out = execFileSync(
      'git',
      ['grep', '-z', '-l', '-F', '-f', '-', rev, '--', ...pathspecs],
      { cwd, input: patterns.join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    return out
      .split('\0')
      .filter(Boolean)
      .map((hit) => hit.slice(rev.length + 1));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

const NOT_TEXT_ONLY = (reason) => ({
  textOnly: false,
  reason,
  vitestFiles: [],
  browser: 'full',
  specs: [],
});

/** The whole decision for `base..head` in the repository at `cwd`. */
export function classify(
  ts,
  base,
  head,
  { cwd = process.cwd(), pattern = securityPathPattern() } = {}
) {
  for (const rev of [base, head])
    if (!/^[\w./^~-]+$/.test(rev ?? '')) return NOT_TEXT_ONLY(`bad revision '${rev}'`);
  // `--raw` carries both modes, so a chmod or a symlink swap is never a text edit.
  const raw = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, head], cwd)
    .split('\0')
    .filter(Boolean);
  if (raw.length === 0) return NOT_TEXT_ONLY('the diff is empty');
  const changes = [];
  const prose = [];
  const code = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = raw[i].slice(1).split(' ');
    const path = raw[i + 1];
    if (path === undefined) return NOT_TEXT_ONLY('git diff --raw was cut short');
    const refusal = pathRefusal(path, status, pattern);
    if (refusal) return NOT_TEXT_ONLY(refusal);
    if (status === 'M' && (oldMode !== newMode || !/^1006[0-9]{2}$/.test(newMode)))
      return NOT_TEXT_ONLY(`${path} changed its file mode or is not a regular file`);
    if (PROSE_FILE.test(path)) {
      prose.push(path);
      continue;
    }
    const result = compareSource(
      ts,
      path,
      git(['cat-file', 'blob', oldSha], cwd),
      git(['cat-file', 'blob', newSha], cwd)
    );
    if (result.refusal) return NOT_TEXT_ONLY(result.refusal);
    code.push(path);
    changes.push(...result.changes);
  }

  // What the old text could still be asserted as. A multi-line string is
  // searched line by line, since git grep matches within a line.
  const oldTexts = [
    ...new Set(changes.flatMap((c) => c.old.split('\n').map(jsxNormal).filter(Boolean))),
  ];
  const proseNames = prose.map((p) => p.split('/').pop());
  const tests = grepFiles(
    head,
    [...oldTexts, ...proseNames],
    ['*.test.ts', '*.test.tsx', '*.test.js', '*.test.mjs'],
    cwd
  );
  if (tests.length > MAX_TESTS)
    return NOT_TEXT_ONLY(
      `the old text is quoted by ${tests.length} test files, too many for the lane`
    );
  const vitestFiles = [...new Set([...code, ...prose, ...tests])].sort();

  // Browser: the specs that quote old copy, plus any spec the change edits.
  // Anything else under apps/e2e that quotes it (a page object, a fixture, a
  // spec another config runs) cannot be mapped to specs, so the full suite runs,
  // and so does it for rendered Markdown under apps/ or packages/.
  const e2eHits = grepFiles(head, oldTexts, ['apps/e2e'], cwd);
  const e2eEdits = [...code, ...prose].filter((p) => p.startsWith('apps/e2e/'));
  const specs = [...new Set([...e2eHits, ...e2eEdits])].sort();
  const oddSpec = specs.find((p) => !/^apps\/e2e\/tests\/[\w./-]+\.spec\.ts$/.test(p));
  const renderedProse = prose.find((p) => /^(apps|packages)\//.test(p));
  let browser = specs.length ? 'specs' : 'none';
  if (oddSpec || renderedProse || specs.length > MAX_SPECS) browser = 'full';
  return {
    textOnly: true,
    reason: `${code.length} code file(s) change only text, ${prose.length} Markdown file(s)`,
    vitestFiles,
    browser,
    specs: browser === 'specs' ? specs.map((p) => p.slice('apps/e2e/'.length)) : [],
  };
}

/** The decision as GitHub step outputs, one `key=value` per line. */
export function toOutputs(decision) {
  return [
    `text_only=${decision.textOnly}`,
    `reason=${decision.reason.replace(/\s+/g, ' ')}`,
    `vitest_files=${JSON.stringify(decision.vitestFiles)}`,
    `browser=${decision.browser}`,
    `specs=${JSON.stringify(decision.specs)}`,
  ].join('\n');
}

async function main(argv) {
  let decision;
  try {
    if (argv.length !== 2) throw new Error('usage: text-only-scope.mjs <base-sha> <head-sha>');
    const ts = (await import('typescript')).default;
    decision = classify(ts, argv[0], argv[1]);
  } catch (error) {
    decision = NOT_TEXT_ONLY(`could not decide: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  console.error(
    `text-only scope: ${decision.textOnly ? 'text only' : 'not text only'}: ${decision.reason}`
  );
  console.log(toOutputs(decision));
}

// Real paths on both sides: a runner's temp directory may sit behind a symlink
// (macOS's /var is /private/var), and a mismatch would print nothing at all.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main(process.argv.slice(2));
}
