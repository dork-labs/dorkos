/**
 * Measure every block of in-app copy and flag the ones that are too long.
 *
 * WHY THIS EXISTS. The app-copy standard (`writing-app-copy` skill, decided by
 * the operator on 2026-10-02) caps how many words one block of copy may carry:
 * three or fewer is preferred, six or fewer is good, seven to fifteen is
 * allowed but flagged, and sixteen or more is never allowed. The baseline the
 * day the rule was set is in ledger entry `ci/ledger/261002-185940-copy-length-gate.md`;
 * the longest block was 82 words. A length rule nobody measures
 * drifts back the first week, so this script measures it on every change.
 *
 * WHAT A BLOCK IS. One piece of copy a person reads as a unit:
 *
 *   - the text children of one JSX element, joined. `<p>Couldn’t reach
 *     {name}. Try again.</p>` is ONE block of five words, not two fragments.
 *     Inline formatting elements (`<strong>`, `<em>`, `<a>`, `<Link>` …, see
 *     {@link INLINE_ELEMENTS}) are part of the sentence around them, so their
 *     text joins the block. Any other child element ends the run and is
 *     measured as its own block.
 *   - a string or template literal in a copy position, exactly as
 *     `check-vocab-gate.ts` classifies one ({@link isCopySink}): a `label=`,
 *     `title=`, `description=` attribute, a `{ message: '…' }` property, a
 *     `toast.*()` argument. A title and its description are two blocks, which
 *     is what lets a dialog carry a short title AND a short body.
 *
 * HOW WORDS ARE COUNTED. A word is a whitespace-separated token with at least
 * one letter or digit in it, so "·", "…" and "→" are free. An interpolation
 * (`{name}`, `${count}`) counts as one word: it renders as at least one. A
 * `{cond ? 'A' : 'B'}` child counts as its longest literal branch, because
 * that is the longest thing a person can see.
 *
 * WHAT IT SKIPS. Everything `check-vocab-gate.ts`'s {@link collectFiles}
 * skips (`__tests__/`, the Dev Playground), plus `*.test.*` and `*.stories.*`
 * files. Text inside `<code>`, `<pre>` and `<kbd>` is a sample, not prose, so
 * it counts as one word. Only `apps/client/src` is scanned: the server's
 * `message:`/`description:` properties include OpenAPI and schema text no
 * person reads in the app, and counting those would bury the real offenders.
 *
 * THE KNOWN GAP is the vocab gate's own: a string handed to an ordinary helper
 * (`plural(n, '…', '…')`) or returned from a function is not in a copy
 * position, so it is not measured. Read a file with helper-built copy as well
 * as scanning it.
 *
 * MODES. With `--report-only` it prints the report and always exits 0; this
 * is how it lands, before the copy sweep that brings every block under the
 * cap. Without the flag it exits 1 when any block reaches
 * {@link ERROR_AT} words. `--warnings` also lists every flagged 7-15 block.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-copy-length.ts [--report-only] [--warnings] [repoRoot]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectFiles, isCopySink } from './check-vocab-gate.ts';

/** Workspaces whose copy this script measures. See the module doc for why only the client. */
const DEFAULT_SCAN_ROOTS = ['apps/client/src'];

/** Fewest words that make a block an error: "16+ never". */
export const ERROR_AT = 16;

/** Fewest words that flag a block as a warning: "7-15 allowed but flagged". */
export const WARN_AT = 7;

/**
 * Elements whose text belongs to the sentence around them. Their text joins
 * the enclosing block rather than starting a new one.
 *
 * `span` is left out on purpose: this codebase uses it as often for a
 * separate line (a label's description, `block` styled) as for a word inside
 * a sentence, and joining a label to its description reports one block that
 * no person reads as one. Splitting a sentence at a span undercounts instead,
 * which is the safe direction for a gate.
 */
const INLINE_ELEMENTS = new Set([
  'a',
  'abbr',
  'b',
  'br',
  'em',
  'i',
  'mark',
  's',
  'small',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'Link',
]);

/** Elements whose content is a sample, not prose. Each counts as one word. */
const SAMPLE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp']);

/** How a block's length is judged against the standard. */
export type LengthBand = 'preferred' | 'good' | 'flagged' | 'error';

/** One measured block of copy. */
export interface CopyBlock {
  /** Repo-relative path, `/`-separated. */
  file: string;
  /** 1-based line of the block's first character. */
  line: number;
  /** Words, counted as the module doc describes. */
  words: number;
  /** The block's text, with each interpolation shown as `{…}`. */
  text: string;
}

/**
 * Count the words in a piece of copy: whitespace-separated tokens that hold
 * at least one letter or digit, plus each `{…}` interpolation marker, which
 * renders as at least one word.
 *
 * @param text - The copy to count, with interpolations already replaced by `{…}`.
 */
export function countWords(text: string): number {
  let words = 0;
  for (const token of text.split(/\s+/)) {
    const markers = token.match(/\{…\}/g)?.length ?? 0;
    const rest = token.replace(/\{…\}/g, '');
    words += markers + (/[\p{L}\p{N}]/u.test(rest) ? 1 : 0);
  }
  return words;
}

/**
 * Place a word count on the standard's scale.
 *
 * @param words - A block's word count.
 */
export function bandFor(words: number): LengthBand {
  if (words >= ERROR_AT) return 'error';
  if (words >= WARN_AT) return 'flagged';
  if (words > 3) return 'good';
  return 'preferred';
}

/** The tag name of a JSX element or self-closing element, or `''` for a fragment. */
function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): string {
  if (ts.isJsxFragment(node)) return '';
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

/** True when a JSX child is a sample element (`<code>` …) that reads as one word of its sentence. */
function isSampleChild(child: ts.JsxChild): boolean {
  return (
    (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) &&
    SAMPLE_ELEMENTS.has(tagName(child))
  );
}

/** True when a JSX child is an inline element whose text joins the block around it. */
function isInlineChild(child: ts.JsxChild): child is ts.JsxElement | ts.JsxSelfClosingElement {
  return (
    (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) &&
    // `<Foo.Link>` is a `Link` too: match the last segment of a dotted name.
    INLINE_ELEMENTS.has(tagName(child).split('.').pop() ?? '')
  );
}

/** Collapse whitespace the way JSX renders it. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** JSX text with its HTML entities (`&nbsp;`, `&mdash;`) blanked, so they are not counted as words. */
function jsxText(node: ts.JsxText): string {
  return node.text.replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, ' ');
}

/** True when a node is a `+` expression, the operator copy is concatenated with. */
function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** True when a `+` chain has at least one string or template literal operand. */
function plusHasLiteral(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return plusHasLiteral(node.expression);
  if (isPlus(node)) return plusHasLiteral(node.left) || plusHasLiteral(node.right);
  return ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);
}

/**
 * The text an expression renders inside a piece of copy: a literal's own
 * text, the longest branch of a conditional, the joined operands of a `+`
 * chain, and `{…}` for any value, which renders as at least one word.
 */
function renderedText(node: ts.Expression): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return renderedText(node.expression);
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => ` ${renderedText(span.expression)} ${span.literal.text}`),
    ].join('');
  }
  if (ts.isConditionalExpression(node)) {
    const a = renderedText(node.whenTrue);
    const b = renderedText(node.whenFalse);
    return countWords(b) > countWords(a) ? b : a;
  }
  if (isPlus(node) && plusHasLiteral(node)) {
    return `${renderedText(node.left)}${renderedText(node.right)}`;
  }
  return ' {…} ';
}

/**
 * The text one unit of copy renders, or `undefined` when the node does not
 * start one. A unit is a string literal, a template literal, or a whole `+`
 * chain with a literal in it, so `'Couldn’t reach ' + name + '. Try again.'`
 * is one block rather than two fragments.
 */
function unitText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return renderedText(node);
  if (isPlus(node) && !isPlus(node.parent) && plusHasLiteral(node)) return renderedText(node);
  return undefined;
}

/**
 * Measure every block of copy in one source file.
 *
 * @param filePath - Repo-relative path, used for the result and for picking TSX parsing.
 * @param text - The file's source.
 */
export function measureSource(filePath: string, text: string): CopyBlock[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const blocks: CopyBlock[] = [];
  // Literals already counted as part of a JSX children run, so the literal
  // walk below does not count them a second time as blocks of their own.
  const consumed = new Set<ts.Node>();
  // Inline elements whose text already joined the run around them; measuring
  // their children again would count those words twice.
  const joined = new Set<ts.Node>();

  function push(node: ts.Node, rendered: string): void {
    const display = collapse(rendered).trim();
    const words = countWords(display);
    if (words === 0) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    blocks.push({ file: filePath, line: line + 1, words, text: display });
  }

  /**
   * The text one JSX expression child contributes to a run. The longest
   * literal branch when it holds copy literals, `{…}` when it holds a value,
   * and nothing when it holds JSX, which is measured as its own blocks.
   */
  function expressionText(expr: ts.JsxExpression): { text: string; authored: boolean } {
    if (!expr.expression) return { text: '', authored: false };
    let containsJsx = false;
    const literals: string[] = [];
    const scan = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        containsJsx = true;
        return;
      }
      const rendered = unitText(node);
      if (rendered !== undefined && isCopySink(node)) {
        literals.push(rendered);
        consumed.add(node);
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(expr.expression);
    if (literals.length > 0) {
      const longest = literals.reduce((a, b) => (countWords(b) > countWords(a) ? b : a));
      // `{' '}` is spacing, not copy: only a literal with a word in it makes
      // the run authored.
      return { text: ` ${longest} `, authored: countWords(longest.replace(/\{…\}/g, '')) > 0 };
    }
    if (containsJsx) return { text: '', authored: false };
    return { text: ' {…} ', authored: false };
  }

  /** The text an inline element contributes to the run around it. */
  function inlineText(node: ts.JsxElement | ts.JsxSelfClosingElement): {
    text: string;
    authored: boolean;
  } {
    if (ts.isJsxSelfClosingElement(node)) return { text: ' ', authored: false };
    return childrenText(node.children);
  }

  /** Join a run of JSX children into the text it renders. */
  function childrenText(children: readonly ts.JsxChild[]): { text: string; authored: boolean } {
    let text = '';
    let authored = false;
    for (const child of children) {
      if (ts.isJsxText(child)) {
        const plain = jsxText(child);
        if (countWords(plain) > 0) authored = true;
        text += plain;
      } else if (ts.isJsxExpression(child)) {
        const part = expressionText(child);
        text += part.text;
        authored ||= part.authored;
      } else if (isSampleChild(child)) {
        text += ' {…} ';
      } else if (isInlineChild(child)) {
        joined.add(child);
        const part = inlineText(child);
        text += part.text;
        authored ||= part.authored;
      }
    }
    return { text, authored };
  }

  /**
   * Split an element's children into runs at every non-inline child element,
   * and record each run as one block.
   */
  function measureChildren(children: readonly ts.JsxChild[]): void {
    let run: ts.JsxChild[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const { text: rendered, authored } = childrenText(run);
      // A run of nothing but interpolations (`<p>{name}</p>`) renders data,
      // not authored copy, so it is not a block.
      const first = run[0];
      if (authored && first) push(first, rendered);
      run = [];
    };
    for (const child of children) {
      const breaksRun =
        (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) &&
        !isInlineChild(child) &&
        !isSampleChild(child);
      if (breaksRun) flush();
      else run.push(child);
    }
    flush();
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      if (SAMPLE_ELEMENTS.has(tagName(node))) {
        // A sample's text is not prose, but its attributes (`title=`,
        // `aria-label=`) still are.
        if (ts.isJsxElement(node)) ts.forEachChild(node.openingElement, visit);
        return;
      }
      if (!joined.has(node)) measureChildren(node.children);
      ts.forEachChild(node, visit);
      return;
    }
    // Already joined into a JSX children run, operands included.
    if (consumed.has(node)) return;
    const rendered = unitText(node);
    if (rendered !== undefined && isCopySink(node)) {
      push(node, rendered);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return blocks;
}

/** `relative()`'s output with OS separators normalized to `/`. */
function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

/**
 * Measure every block of copy under `scanRoots`.
 *
 * @param repoRoot - Repo root to scan from. Defaults to the current working directory.
 * @param scanRoots - Workspace-relative roots to scan. Defaults to {@link DEFAULT_SCAN_ROOTS}.
 */
export function runCopyLength(
  repoRoot: string = process.cwd(),
  scanRoots: string[] = DEFAULT_SCAN_ROOTS
): CopyBlock[] {
  const blocks: CopyBlock[] = [];
  for (const file of collectFiles(scanRoots, repoRoot)) {
    if (/\.(test|spec|stories)\.tsx?$/.test(file)) continue;
    const relPath = toPosixRelative(repoRoot, file);
    blocks.push(...measureSource(relPath, readFileSync(file, 'utf8')));
  }
  return blocks;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const listWarnings = args.includes('--warnings');
  const repoRoot =
    args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..');

  const blocks = runCopyLength(repoRoot);
  if (blocks.length === 0) {
    // A wrong root or a moved scan root measures nothing and would pass
    // silently in either mode, so an empty scan is an error of its own.
    console.error(
      `check-copy-length: no copy found under ${DEFAULT_SCAN_ROOTS.join(', ')} in ${repoRoot}.`
    );
    process.exit(1);
  }
  const byBand = (band: LengthBand) => blocks.filter((b) => bandFor(b.words) === band);
  const errors = byBand('error').sort((a, b) => b.words - a.words);
  const flagged = byBand('flagged').sort((a, b) => b.words - a.words);
  const show = (b: CopyBlock) =>
    `  ${String(b.words).padStart(3)}  ${b.file}:${b.line}\n       ${b.text.slice(0, 160)}`;

  if (listWarnings && flagged.length > 0) {
    console.log(`Flagged, ${WARN_AT}-${ERROR_AT - 1} words (shorten if you can):\n`);
    for (const b of flagged) console.log(show(b));
    console.log('');
  }
  if (errors.length > 0) {
    console.log(`Too long, ${ERROR_AT}+ words (never allowed):\n`);
    for (const b of errors) console.log(show(b));
    console.log('');
  }

  console.log(
    `check-copy-length: ${blocks.length} blocks in ${DEFAULT_SCAN_ROOTS.join(', ')}. ` +
      `1-3: ${byBand('preferred').length}, 4-6: ${byBand('good').length}, ` +
      `${WARN_AT}-${ERROR_AT - 1} (flagged): ${flagged.length}, ${ERROR_AT}+ (error): ${errors.length}.`
  );

  if (errors.length > 0) {
    console.log(
      '\nCut each block to 15 words or fewer. Split it into a title and a body, then move ' +
        'the extra detail into an expandable section, a popover or an info tip, and link to ' +
        'docs only as a last resort. The standard: the writing-app-copy skill.'
    );
    if (!reportOnly) process.exit(1);
  }
}
