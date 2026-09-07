/**
 * Types for `code-only.mjs`, which is plain JavaScript so that the `.claude/`
 * hooks — which run under bare node with no build step — can import the same
 * stripper the TypeScript guards use. See that file for what it does and why.
 *
 * @module scripts/lib/code-only
 */

/**
 * A source file's code, with comments and literal text blanked to spaces, plus
 * how much of the file TypeScript could not parse.
 *
 * A corpus scan should assert `parseErrors` is zero across it: an unparseable
 * file lexes to guesswork and reports "nothing found" exactly like a clean one.
 *
 * @param text - The file's full source.
 * @param fileName - The file's name or path, which decides how it is lexed
 *   (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns The blanked source (same length as the input) and the parse-error
 *   count of the lexing that produced it.
 */
export declare function lex(text: string, fileName?: string): { code: string; parseErrors: number };

/**
 * A source file's code, with comments and literal text blanked to spaces.
 *
 * Line and column positions are preserved exactly, so a hit in the result maps
 * back to the same place in the input.
 *
 * @param text - The file's full source.
 * @param fileName - The file's name or path, which decides how it is lexed
 *   (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns The same source, same length, with every non-code span blanked.
 */
export declare function codeOnly(text: string, fileName?: string): string;

/**
 * A source file with its COMMENTS blanked to spaces and every literal left
 * exactly as written, plus how much of the file TypeScript could not parse.
 *
 * The stripper for guards that ask "does this file SAY this word?" rather than
 * "is this token a call?" — the answer usually lives in a literal (a Tailwind
 * class, an import specifier, a prompt's prose), which `lex` blanks away. A
 * corpus scan should assert `parseErrors` is zero across it, for the same
 * reason `lex` gives.
 *
 * @param text - The file's full source.
 * @param fileName - The file's name or path, which decides how it is lexed
 *   (`.tsx` and `.jsx` differ from `.ts` and `.js`). Defaults to TypeScript.
 * @returns The source with comments blanked (same length as the input) and the
 *   parse-error count behind it.
 */
export declare function lexWithoutComments(
  text: string,
  fileName?: string
): { code: string; parseErrors: number };
