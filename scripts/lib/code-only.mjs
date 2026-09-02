/**
 * The repo's one source stripper: a file's CODE, with every comment, string,
 * template chunk, regex literal and JSX text blanked out.
 *
 * ## Why this exists, and why it is not regexes
 *
 * Several guards in this repo scan source text for a token and must not be
 * fooled by prose — a TSDoc naming `applyConfigPatch(` is documentation, not a
 * call path. Every one of them used to strip comments and strings with a pair
 * of independent regexes, and **no fixed order of those regexes can be
 * correct**, because comments can contain string delimiters and strings can
 * contain comment delimiters. Whichever kind you blank first, source of the
 * other kind desynchronises it. All three orders were demonstrated live in this
 * repo (DOR-642):
 *
 * - **Block comments first** is fooled by a `/*` inside a LINE comment.
 *   `apps/server/src/index.ts:322` ended a `//` comment with the route glob
 *   `/api/auth/` + `*`, opening a fake comment that ran to the next `*` + `/`
 *   **1,530 lines later**. Everything in between was invisible to the scan.
 * - **Line comments first** is fooled by a `/*` inside a STRING.
 *   `apps/server/src/app.ts:145` is `app.all('/api/auth/*splat', …)`, and the
 *   fake block comment it opens swallowed the entire router mount table —
 *   `sessionGate`, `resolveAgentIdentity` and every `app.use('/api/…')` with it.
 *   An ungated route calling a protected effect below that line read as GREEN.
 * - **Strings first** has the mirror bug one level up: an APOSTROPHE in prose
 *   opens a fake string. `services/workbench-serve/token.ts:7` says "the API's
 *   cookie/header", which swallows everything up to the next quote. That
 *   pipeline lost most of the content of 216 of 454 server sources.
 *
 * ## How this one is correct
 *
 * The lexing is delegated to the real thing. `ts.createSourceFile` decides what
 * is a string, what is a template chunk, what is JSX text, and — the part no
 * regex can do at all — whether a `/` opens a regular expression or is
 * division. Those ranges are blanked first.
 *
 * Comments are then removed by a single LEFT-TO-RIGHT pass, not by a regex per
 * comment form. That is what makes the ordering problem go away rather than
 * move: after literal blanking, no string or regex delimiter survives to fool
 * the pass, and because it walks the text once it can never let one comment
 * form open a span inside the other. Two comment regexes still could, even
 * after literal blanking: `/* a // b *\/ realCode()` loses `realCode()` to a
 * line-comment regex that runs first and eats the closing `*` + `/` with it.
 *
 * ## Positions are preserved
 *
 * Everything removed is replaced with spaces, and newlines are kept, so the
 * output has the same length and the same line and column numbers as the input.
 * Callers that map a hit back to a line in the original file (the `any` hook
 * does) stay correct; deleting a multi-line block comment instead would shift
 * every line below it and misreport.
 *
 * ## What it still cannot see
 *
 * The token inside a template literal's TEXT (`` `applyShape(` ``) is blanked,
 * but a call inside a template SUBSTITUTION is real code and is kept — which is
 * why only the literal chunks are blanked and recursion continues into `${…}`.
 * Aliasing (`const f = applyShape; f()`) and dynamic dispatch are out of reach
 * of any textual scan and always will be.
 *
 * Note which direction over-blanking would err in, because it is easy to
 * mis-tune: a call expression can never exist inside a string literal, so
 * blanking string content is INCAPABLE of hiding a call. A file that blanks to
 * almost nothing (`lib/git-safety.ts` is mostly a table of banned command
 * strings) is this working, not failing. Do not tune toward a retention floor —
 * that means deliberately leaving literal content in, which is where false
 * positives come from.
 *
 * This is plain `.mjs` rather than TypeScript on purpose: `.claude/hooks/` runs
 * under bare node with no build step, and a stripper that the hooks cannot
 * import is a stripper that gets copied and then diverges, which is the whole
 * of DOR-642. `code-only.d.mts` beside it gives the TypeScript callers types.
 *
 * @module scripts/lib/code-only
 */

import ts from 'typescript';

/** File extensions mapped to how TypeScript should lex them. */
const SCRIPT_KIND_BY_EXTENSION = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

/**
 * How to lex a file, from its name.
 *
 * The distinction is not cosmetic: `.ts` and `.tsx` disagree about `<T>expr`,
 * which is a type assertion in one and an unclosed JSX tag in the other, so
 * lexing a file as the wrong kind produces a different literal map.
 *
 * @param {string} fileName - The file's name or path; only its extension matters.
 * @returns {ts.ScriptKind} The script kind to parse with, defaulting to TS.
 */
function scriptKindFor(fileName) {
  const dot = fileName.lastIndexOf('.');
  const extension = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
  return SCRIPT_KIND_BY_EXTENSION.get(extension) ?? ts.ScriptKind.TS;
}

/**
 * Whether a node is a literal chunk whose TEXT is not code.
 *
 * Template heads, middles and tails are listed individually because a template
 * EXPRESSION is not a literal — its substitutions hold real calls.
 *
 * @param {ts.Node} node - The node to classify.
 * @returns {boolean} True when the node's whole range may be blanked.
 */
function isNonCodeLiteral(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isJsxText(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  );
}

/**
 * A source file's code, with comments and literal text blanked to spaces.
 *
 * Line and column positions are preserved exactly, so a hit in the result maps
 * back to the same place in the input.
 *
 * @param {string} text - The file's full source.
 * @param {string} [fileName] - The file's name or path, which decides how it is
 *   lexed (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns {string} The same source, same length, with every non-code span blanked.
 */
export function codeOnly(text, fileName = 'scan.ts') {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(fileName)
  );

  // `split('')` and NOT `[...text]`: TypeScript reports positions in UTF-16 code
  // units, and spreading a string yields CODE POINTS. One emoji anywhere above a
  // literal shifts every later index by one, so the blanked range slides off the
  // literal and onto the code after it — over-blanking real code, the one
  // direction that can hide a call.
  const chars = text.split('');
  const length = chars.length;

  /**
   * Blank `[start, end)`, keeping newlines so positions survive.
   *
   * @param {number} start - First index to blank.
   * @param {number} end - Index after the last one to blank.
   * @returns {void}
   */
  const blank = (start, end) => {
    for (let i = Math.max(start, 0); i < end && i < length; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };

  /**
   * Blank every literal chunk in the tree.
   *
   * @param {ts.Node} node - The node to visit.
   * @returns {void}
   */
  const visit = (node) => {
    if (isNonCodeLiteral(node)) blank(node.getStart(source), node.end);
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Comments, in ONE left-to-right pass over text that no longer holds a string
  // or regex delimiter. An unterminated block comment runs to end of file, which
  // is what the language says it does.
  for (let i = 0; i < length;) {
    if (chars[i] !== '/') {
      i++;
      continue;
    }
    if (chars[i + 1] === '/') {
      let end = i;
      while (end < length && chars[end] !== '\n' && chars[end] !== '\r') end++;
      blank(i, end);
      i = end;
    } else if (chars[i + 1] === '*') {
      let end = i + 2;
      while (end < length && !(chars[end] === '*' && chars[end + 1] === '/')) end++;
      const past = end < length ? end + 2 : length;
      blank(i, past);
      i = past;
    } else {
      i++;
    }
  }

  return chars.join('');
}
