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
