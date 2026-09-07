/**
 * The repo's one source stripper: a file's CODE, with every comment, string,
 * template chunk, regex literal and JSX text blanked out.
 *
 * Two questions are asked of source text in this repo, so there are two answers
 * over one lexing. `codeOnly`/`lex` answer "is this token a CALL?" and blank the
 * literals with the comments. `lexWithoutComments` answers "does this file SAY
 * this word?" and blanks only the comments, because for that family the subject
 * — a Tailwind class, an import specifier, a prompt's prose — lives inside a
 * literal and blanking it would make the guard vacuously green. Everything
 * below about ordering applies to both: the comment spans are found the same
 * way for each.
 *
 * The asymmetry is deliberate rather than an oversight. `codeOnly` exists
 * because most call-scanning callers hold ONE file and have no corpus to assert
 * `parseErrors` over. Every comment-only caller in this repo sweeps a directory
 * or a named file list, so all of them want the count — a count-less twin here
 * would have no consumer, and an export nobody imports is the thing that rots.
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
 *   cookie/header", which swallows everything up to the next quote. When
 *   DOR-642 measured it, that pipeline lost most of the content of 216 of the
 *   454 server sources there were then.
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

/** The JSX-accepting twin of a script kind, for the fallback below. */
const JSX_TWIN = new Map([
  [ts.ScriptKind.TS, ts.ScriptKind.TSX],
  [ts.ScriptKind.JS, ts.ScriptKind.JSX],
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
 * Parse once, reporting how badly it went.
 *
 * @param {string} text - The file's full source.
 * @param {string} fileName - The name to parse under.
 * @param {ts.ScriptKind} kind - How to lex it.
 * @returns {{ source: ts.SourceFile, errors: number }} The tree and its parse-error count.
 */
function parseOnce(text, fileName, kind) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  // `parseDiagnostics` is TypeScript-internal, so it is read defensively: a
  // future release that renames it must degrade to "no errors seen" (the
  // fallback below simply never fires) rather than throwing inside a hook.
  return { source, errors: source.parseDiagnostics?.length ?? 0 };
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
 * Blank `[start, end)` of `chars`, keeping newlines so positions survive.
 *
 * @param {string[]} chars - The character array to mutate.
 * @param {number} start - First index to blank.
 * @param {number} end - Index after the last one to blank.
 * @returns {void}
 */
function blankRange(chars, start, end) {
  for (let i = Math.max(start, 0); i < end && i < chars.length; i++) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

/**
 * The one pass both exports are built from: literals blanked, comments located.
 *
 * Finding the comments is the part that has to happen in this order. The spans
 * are read off text whose literals are already blanked, so no string or regex
 * delimiter survives to open a fake comment — and the left-to-right walk means
 * one comment form can never open a span inside the other. What a caller does
 * with the spans afterwards is its own business: `lex` keeps the blanked chars,
 * and `lexWithoutComments` applies the same spans to the ORIGINAL text so the
 * literals come back untouched.
 *
 * The JSX retry lives here rather than in either export, so both readings of a
 * file agree about what it is: a `.ts` file holding JSX parses as a pile of
 * errors and lexes to nonsense. Rather than keeping a list of directories that
 * are secretly TSX — which rots, and is wrong the day somebody adds the next
 * one — the parse is retried under the JSX-accepting twin and the better result
 * wins. A file that is genuinely broken gets errors either way and keeps its
 * original reading; only a file the twin can actually parse switches.
 *
 * @param {string} text - The file's full source.
 * @param {string} fileName - The file's name or path, which decides how it is lexed.
 * @returns {{ chars: string[], comments: [number, number][], parseErrors: number }}
 *   The literal- and comment-blanked characters, the comment spans that were
 *   blanked out of them, and the parse-error count of the lexing behind both.
 */
function analyze(text, fileName) {
  const kind = scriptKindFor(fileName);
  let parsed = parseOnce(text, fileName, kind);

  const twin = JSX_TWIN.get(kind);
  if (parsed.errors > 0 && twin !== undefined) {
    const retry = parseOnce(text, fileName, twin);
    if (retry.errors < parsed.errors) parsed = retry;
  }

  const source = parsed.source;

  // `split('')` and NOT `[...text]`: TypeScript reports positions in UTF-16 code
  // units, and spreading a string yields CODE POINTS. One emoji anywhere above a
  // literal shifts every later index by one, so the blanked range slides off the
  // literal and onto the code after it — over-blanking real code, the one
  // direction that can hide a call.
  const chars = text.split('');
  const length = chars.length;

  /**
   * Blank every literal chunk in the tree.
   *
   * @param {ts.Node} node - The node to visit.
   * @returns {void}
   */
  const visit = (node) => {
    if (isNonCodeLiteral(node)) blankRange(chars, node.getStart(source), node.end);
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Comments, in ONE left-to-right pass over text that no longer holds a string
  // or regex delimiter. An unterminated block comment runs to end of file, which
  // is what the language says it does.
  /** @type {[number, number][]} */
  const comments = [];
  for (let i = 0; i < length;) {
    if (chars[i] !== '/') {
      i++;
      continue;
    }
    if (chars[i + 1] === '/') {
      let end = i;
      while (end < length && chars[end] !== '\n' && chars[end] !== '\r') end++;
      comments.push([i, end]);
      i = end;
    } else if (chars[i + 1] === '*') {
      let end = i + 2;
      while (end < length && !(chars[end] === '*' && chars[end + 1] === '/')) end++;
      const past = end < length ? end + 2 : length;
      comments.push([i, past]);
      i = past;
    } else {
      i++;
    }
  }
  for (const [start, end] of comments) blankRange(chars, start, end);

  return { chars, comments, parseErrors: parsed.errors };
}

/**
 * A source file's code, with comments and literal text blanked to spaces, plus
 * how much of the file TypeScript could not parse.
 *
 * `parseErrors` is the honesty channel. Everything this module knows comes from
 * the parse, so a file the parser could not read is a file whose literal map is
 * guesswork — and the failure is SILENT, which is the property that makes it
 * dangerous. A caller scanning a corpus should assert this is zero across it;
 * `codeOnly` drops it only because most callers have one file and no corpus to
 * assert over.
 *
 * The concrete case, and the reason for the JSX fallback in `analyze`: JSX
 * inside a `.ts` file. `apps/server/src/core-extensions/*` is written that way
 * on purpose (the extension pipeline compiles it with esbuild at runtime, so it
 * never meets the server's tsc, and the server tsconfig excludes it). Lexed as
 * TS, `</p>` reads as the start of a regular expression, and everything up to
 * the next `/` becomes literal text — so a call between two closing tags is
 * blanked away and the scan over that file reports nothing, having seen
 * nothing. Retrying as TSX fixes it, and 33 parse errors becoming 0 is what
 * says the retry was right.
 *
 * @param {string} text - The file's full source.
 * @param {string} [fileName] - The file's name or path, which decides how it is
 *   lexed (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns {{ code: string, parseErrors: number }} The blanked source (same
 *   length as the input) and the parse-error count of the lexing that produced it.
 */
export function lex(text, fileName = 'scan.ts') {
  const { chars, parseErrors } = analyze(text, fileName);
  return { code: chars.join(''), parseErrors };
}

/**
 * A source file with its COMMENTS blanked to spaces and every literal left
 * exactly as written, plus how much of the file TypeScript could not parse.
 *
 * ## Why this exists beside `lex`
 *
 * `lex` answers "is this token a call?", so it blanks literals: a call cannot
 * live inside a string, and blanking one is incapable of hiding a call. A whole
 * second family of guards asks a different question — "does this file SAY this
 * word?" — and for them the answer usually lives in a literal. A Tailwind class
 * sits in a `className` string, an import specifier is a string, a prompt's
 * prose is a template literal, a query key is `['config']`. Run those through
 * `lex` and the subject is blanked away: every offender list goes empty and the
 * guard reports a clean green having read nothing it cared about. That is the
 * one failure mode worse than the regexes this module replaced, so the two
 * questions get two functions rather than one function and a flag nobody sets.
 *
 * What those guards genuinely need is only for comments to go, because their
 * own documentation names the thing they forbid — the sentence explaining why
 * `bg-green-500` is retired contains `bg-green-500` — and a guard that reds on
 * its own explanation teaches the next author to delete the explanation.
 *
 * ## Why it is not simply a comment regex
 *
 * It is the same lexing as `lex`, stopped one step earlier. The comment spans
 * are found on literal-blanked text, so the ordering problem in this module's
 * header applies here in full: a `/*` inside a string or a `//` inside a block
 * comment desynchronises any pair of comment regexes, and both were live in
 * this repo. Only the spans are then applied to the original text, so the
 * literals return byte for byte.
 *
 * ## What a caller inherits
 *
 * A token inside a string is VISIBLE here — that is the point — so this reads
 * prose the model or the browser would see, not the call graph. Reach for `lex`
 * when the question is about code. Positions are preserved exactly, so a caller
 * that reports 1-based line numbers keeps reporting the right ones.
 *
 * @param {string} text - The file's full source.
 * @param {string} [fileName] - The file's name or path, which decides how it is
 *   lexed (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns {{ code: string, parseErrors: number }} The source with comments
 *   blanked (same length as the input) and the parse-error count behind it.
 */
export function lexWithoutComments(text, fileName = 'scan.ts') {
  const { comments, parseErrors } = analyze(text, fileName);
  const chars = text.split('');
  for (const [start, end] of comments) blankRange(chars, start, end);
  return { code: chars.join(''), parseErrors };
}

/**
 * A source file's code, with comments and literal text blanked to spaces.
 *
 * Line and column positions are preserved exactly, so a hit in the result maps
 * back to the same place in the input. This is `lex` without the parse-error
 * count — reach for `lex` when you scan a whole corpus, so an unparseable file
 * cannot report "nothing found" and pass for a clean scan.
 *
 * @param {string} text - The file's full source.
 * @param {string} [fileName] - The file's name or path, which decides how it is
 *   lexed (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns {string} The same source, same length, with every non-code span blanked.
 */
export function codeOnly(text, fileName = 'scan.ts') {
  return lex(text, fileName).code;
}
