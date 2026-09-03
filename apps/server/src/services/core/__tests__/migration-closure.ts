/**
 * How both migration guards read `config-manager.ts` as text.
 *
 * A migration key's line in `CONFIG_MIGRATIONS` is usually just a call — half
 * the table is a bare reference (`'0.50.0': backfillSidebarDefaults`) — so the
 * text of that line pins a function NAME and nothing about what the function
 * does. Everything that decides BEHAVIOR lives in the top-level declarations the
 * key reaches: the helpers it calls, the helpers those call, and the constants
 * they act on (`migrateSidebarSectionPrefs` deletes exactly the keys named in
 * `RETIRED_SIDEBAR_KEYS`, so following calls alone would freeze the code and
 * leave the list editable).
 *
 * That reachability walk was written for the append-only pins (DOR-1222) and
 * lives here because the tag-based rule needs the same walk for the same reason
 * (DOR-1135): a tamper seeded into a helper that a SHIPPED key calls used to
 * pass `checkMigrationSafety` while the identical tamper written inline went
 * red. This module holds the walk and the text normalization; the two rules
 * decide what to do with the answer.
 *
 * The dependency runs one way on purpose. Nothing here knows about migration
 * keys, tags or pins, so `migration-safety.ts` and `migration-append-only.ts`
 * can both import it without either importing the other.
 *
 * ## Why the text is normalized before it is compared
 *
 * Comments are removed, a trailing comma or semicolon before a closer is
 * removed, whitespace runs collapse to one space and disappear entirely beside
 * brackets, separators, `.` and `<`/`>`. That is deliberately robust to Prettier
 * churn — reflowing a call across lines, or re-indenting after an unrelated
 * edit, must not fire a guard whose entire value is that it only ever fires for
 * real.
 *
 * The robustness claim is measured, not asserted, and the measurement is what
 * built the list above. Reformatting `config-manager.ts` at print widths 60, 80,
 * 100, 140 and 200 moves no pin. Each rule earned its place by a width that
 * broke without it: 140 and 200 join a body's last statement onto one line and
 * move all eleven pins without the semicolon rule; 80 breaks a member access
 * onto its own line (`}) .retired`); 60 breaks a generic across lines
 * (`Record< string, … >`). A future `.prettierrc` change must not mass-repin
 * that table — eleven pins moving at once is how a guard gets bulk-bumped and
 * stops meaning anything.
 *
 * **The boundary, stated so nobody over-trusts it.** The walk never leaves
 * `config-manager.ts`, and three keys already reach past that edge into
 * `@dorkos/shared/config-schema`: `0.55.0` reads `ONBOARDING_STEPS`, `0.59.0`
 * reads `ComposerPrefsSchema`, and `0.57.0` calls `toSidebarItemRef` and
 * `normalizeSidebarPrefs`. Narrowing that enum makes a shipped migration delete
 * more; editing those functions rewrites what a shipped rename produces. Neither
 * guard sees either. Following imports was considered and left out on purpose —
 * it would reach the whole config schema, so every ordinary field addition would
 * break every pin and the pins would be bumped reflexively, which is worse than
 * a boundary written down. The migration table itself is also never followed
 * into (see {@link MIGRATION_TABLE}).
 *
 * There is a second, narrower blind spot in the same family. {@link maskNonCode}
 * blanks the inside of template literals wholesale, interpolations included, so
 * a call written as `` `${backfillSomething(store)}` `` is not a call this walk
 * can see. Nothing in `config-manager.ts` is written that way today and nothing
 * should be — a migration body has no reason to compute a string out of another
 * migration helper — but a body that did would be pinned with a hole in it. The
 * mask is deliberately not a parser, and this is what that costs.
 */

/**
 * A top-level function declaration, at column zero.
 *
 * `async` and `*` are matched even though this file has neither today. A form
 * this pattern does not know is not skipped loudly — it is simply never seen, so
 * a migration reaching it would be read with a hole in the middle. Note what
 * the count cross-check in {@link extractTopLevelDeclarations} does and does not
 * cover here: it compares this pattern against itself on two inputs, so it
 * catches the MASK losing a declaration and is blind, by construction, to a
 * declaration form the pattern never expresses.
 */
const TOP_LEVEL_FUNCTION = /^(?:export )?(?:async )?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;

/** A top-level `const`/`let` declaration, at column zero. */
const TOP_LEVEL_BINDING = /^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?=\s*[:=])/gm;

/**
 * The migration table itself, which is never followed into a closure.
 *
 * It is a top-level binding like any other, so a stray mention of its name
 * inside a body would pull the WHOLE table into that key's closure — and then
 * every key's verdict would depend on every other key, so adding one migration
 * would break every pin at once. Excluded by name rather than by luck.
 */
const MIGRATION_TABLE = 'CONFIG_MIGRATIONS';

/** Any identifier-shaped token, used to find the calls a body makes. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * One scanner, two jobs: blank the comments, and optionally the strings too.
 *
 * Length and line breaks are preserved either way, so an offset found in the
 * output is the same offset in the input.
 *
 * @param source - Any TypeScript source text.
 * @param blankStrings - Whether the INSIDE of string and template literals is
 *   blanked as well. True when scanning for structure; false when the result is
 *   the text being compared, where a string's characters are behavior.
 * @returns A same-length copy with the requested ranges blanked.
 */
function blankOut(source: string, blankStrings: boolean): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      // The delimiters stay either way, so a blanked string is still visibly a
      // string rather than a run of spaces that could merge with its neighbours.
      if (blankStrings) blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Blank out everything that is not code, preserving every offset.
 *
 * Comments and the inside of string/template literals become spaces, so a brace,
 * a `function` keyword or a quote appearing in prose or in a string cannot be
 * mistaken for structure.
 *
 * @param source - Any TypeScript source text.
 * @returns A same-length string with non-code blanked out.
 */
function maskNonCode(source: string): string {
  return blankOut(source, true);
}

/**
 * Blank out the comments and nothing else.
 *
 * @param source - Any TypeScript source text.
 * @returns A same-length string with comment characters replaced by spaces.
 */
function stripComments(source: string): string {
  return blankOut(source, false);
}

/**
 * Every family of top-level declaration a closure can reach, as a list.
 *
 * A list rather than two call sites, because the mask cross-check below walks
 * it: covering one family and not the other is the same hole half-fixed, and a
 * third family added here cannot forget to be checked.
 */
const DECLARATION_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'top-level functions', pattern: TOP_LEVEL_FUNCTION },
  { label: 'top-level bindings', pattern: TOP_LEVEL_BINDING },
];

/** A line that is exactly `}` — the end of a top-level declaration. */
const CLOSING_LINE = /\n\}(?=\n|$)/;

/**
 * How many times a global pattern matches, without disturbing shared state.
 *
 * @param pattern - A `g`-flagged pattern; its `lastIndex` is reset first.
 * @param text - The text to count matches in.
 * @returns The number of matches.
 */
function countMatches(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let n = 0;
  while (pattern.exec(text) !== null) n++;
  return n;
}

/**
 * Every top-level function in the file, mapped to its own source text.
 *
 * A declaration runs from its `function` line to the next line that is exactly
 * `}` — which is what Prettier produces for every top-level function here, and
 * is checked rather than assumed: a declaration with no such terminator raises
 * instead of returning a truncated body that would compare stably and pin
 * nothing.
 *
 * The terminator must be a line of its own. Every helper here takes an inline
 * object type, which Prettier breaks across lines and closes with `}): void {`
 * at column zero — so a search for a leading `}` alone stops at the PARAMETER
 * LIST and pins a signature while the body it guards drifts freely underneath.
 * That is not hypothetical: it is what this function did when it was first
 * written, and the check that was supposed to catch it ("does the slice end in
 * `}`?") passed, because a slice cut short at the parameter list ends in `}`
 * too.
 *
 * Top-level `const`/`let` bindings are collected the same way, ending at the
 * first `;` outside any bracket. They matter because a migration's behavior can
 * live in one: `migrateSidebarSectionPrefs` deletes exactly the keys listed in
 * `RETIRED_SIDEBAR_KEYS`, so a walk that followed only function calls would
 * leave that list editable underneath a shipped migration.
 *
 * @param source - The full `config-manager.ts` source text.
 * @returns Each declared name mapped to its declaration text.
 * @throws When a declaration has no terminator, which means this reader has
 *   drifted from the file rather than that the file is safe.
 */
export function extractTopLevelDeclarations(source: string): Record<string, string> {
  const masked = maskNonCode(source);
  const found: Record<string, string> = {};

  // The mask is the part of this guard most likely to be wrong, so it is
  // cross-checked rather than trusted. `blankOut` does not understand REGEX
  // LITERALS: a quote inside one (`/it's/`) reads as a string opening, and
  // everything to the next quote — often the whole rest of the file, since the
  // parity stays flipped — is blanked away. Counting the same pattern over the
  // RAW source and demanding agreement catches that. A raw match the mask
  // correctly excluded (a declaration inside a template literal) also lands
  // here, and stopping to look is the right answer there too.
  //
  // What it buys, stated as measured rather than as hoped. Four shapes of
  // quote-bearing regex were tried against this extractor with the check
  // removed, and every one of them still threw — because the same blanking that
  // hides a declaration also eats some later terminator. But it threw the WRONG
  // error: "function ok has no closing line of its own", or "binding PATTERN
  // never terminates", naming a declaration that is perfectly well-formed and
  // sending the reader to fix a file that is not broken. This check runs first
  // and names the scanner. A genuinely silent drop was not reproduced — and is
  // not ruled out either, which is the other reason the cheap check stays.
  //
  // Every declaration family is checked, not just functions: covering one and
  // not the other is the same hole half-fixed, which is exactly what the first
  // version of this shipped as.
  for (const { label, pattern } of DECLARATION_PATTERNS) {
    const rawCount = countMatches(pattern, source);
    const maskedCount = countMatches(pattern, masked);
    if (rawCount !== maskedCount) {
      throw new Error(
        `the migration guards see ${maskedCount} ${label} after masking but ${rawCount} in ` +
          'the raw source. Something in this file confuses the comment/string scanner — a regex ' +
          'literal containing a quote is the usual cause — so declarations are invisible to the ' +
          'guards. Fix the scanner; do not repin around it.'
      );
    }
  }

  TOP_LEVEL_FUNCTION.lastIndex = 0;
  for (let m = TOP_LEVEL_FUNCTION.exec(masked); m !== null; m = TOP_LEVEL_FUNCTION.exec(masked)) {
    const name = m[1]!;
    const close = masked.slice(m.index).search(CLOSING_LINE);
    if (close === -1) {
      throw new Error(
        `function ${name} has no closing line of its own — the migration guards cannot read ` +
          'this file, which means they are stale rather than that the file is safe.'
      );
    }
    found[name] = source.slice(m.index, m.index + close + 2);
  }

  TOP_LEVEL_BINDING.lastIndex = 0;
  for (let m = TOP_LEVEL_BINDING.exec(masked); m !== null; m = TOP_LEVEL_BINDING.exec(masked)) {
    const name = m[1]!;
    if (name === MIGRATION_TABLE) continue;
    const end = endOfStatement(masked, m.index);
    if (end === -1) {
      throw new Error(
        `binding ${name} never terminates — the migration guards cannot read this file, which ` +
          'means they are stale rather than that the file is safe.'
      );
    }
    found[name] = source.slice(m.index, end);
  }
  return found;
}

/**
 * Index just past the `;` that ends a statement, ignoring any inside brackets.
 *
 * @param masked - Source with comments and string contents blanked.
 * @param from - Where the statement starts.
 * @returns The end index, or -1 when the statement never terminates.
 */
function endOfStatement(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Every top-level declaration a slice of code reaches, transitively, by name.
 *
 * @param slice - The starting text — a migration's line in the table, usually.
 * @param declarations - The file's declarations, from
 *   {@link extractTopLevelDeclarations}.
 * @returns The reached names, sorted, so moving a declaration within the file is
 *   not a change.
 */
export function reachedDeclarations(
  slice: string,
  declarations: Readonly<Record<string, string>>
): string[] {
  const reached = new Set<string>();
  const queue = [slice];
  while (queue.length > 0) {
    const text = maskNonCode(queue.pop()!);
    IDENTIFIER.lastIndex = 0;
    for (let m = IDENTIFIER.exec(text); m !== null; m = IDENTIFIER.exec(text)) {
      const name = m[0];
      const declaration = declarations[name];
      if (declaration === undefined || reached.has(name)) continue;
      reached.add(name);
      queue.push(declaration);
    }
  }
  return [...reached].sort();
}

/**
 * Reduce a run of code to the text whose change is a real change.
 *
 * Comments are already blanked by the caller. Whitespace runs collapse to one
 * space, and the space beside a bracket, comma, semicolon, `.` or `<`/`>` goes
 * entirely — those are the places Prettier introduces a line break, so removing
 * them makes reflow invisible. Whitespace between two words is left alone,
 * because `return foo` and `returnfoo` are not the same program.
 *
 * A trailing comma OR semicolon immediately before a closer is dropped, because
 * both are Prettier's, not the author's: a call gains a trailing comma the
 * moment it breaks across lines, and a body's last statement gains or loses its
 * own line — `void 0;}` against `void 0}` — with the print width. Measured, not
 * assumed: at `--print-width 140` the semicolon rule alone is the difference
 * between all eleven pins moving and none of them moving. The `.` and `<`/`>`
 * entries were found the same way, at widths 80 and 60 (see the module header).
 */
function collapseCode(text: string): string {
  return text
    .replace(/[,;](\s*[)\]}])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([)\]},;.>])/g, '$1')
    .replace(/([([{,;<])\s+/g, '$1');
}

/**
 * Strip a source slice down to the text whose change is a real change.
 *
 * Code is collapsed; the CONTENTS of string and template literals are copied
 * through untouched, because the characters in a string are behavior — a seeded
 * key name with a space in it is a different key.
 *
 * @param text - A slice of TypeScript source.
 * @returns The normalized text that gets hashed or compared.
 */
export function normalizeForHash(text: string): string {
  const masked = maskNonCode(text);
  const code = stripComments(text);

  let out = '';
  let buffer = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    // Blank in both passes is a comment; blank only in the masked pass is the
    // inside of a string.
    const isStringContent = masked[i] === ' ' && code[i] !== ' ';
    if (isStringContent !== inString) {
      out += inString ? buffer : collapseCode(buffer);
      buffer = '';
      inString = isStringContent;
    }
    buffer += isStringContent ? text[i] : code[i];
  }
  out += inString ? buffer : collapseCode(buffer);
  return out.trim();
}
