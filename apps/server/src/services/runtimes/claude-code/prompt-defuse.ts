/**
 * Words from somebody who is not the person at this computer, made safe to hand Claude Code as
 * words (DOR-2955).
 *
 * Claude Code acts on two things in a user message before any tool runs, so neither the
 * permission mode nor a `PreToolUse` hook ever sees them (measured on the pinned binary, SDK
 * 0.3.280, against a mock endpoint):
 *
 * - **A file reference.** An `@` at the start of the message or after any whitespace, followed by
 *   a path (`@/etc/hosts`, `@~/…`, `@notes.md`, `@"a path"`), is read and its contents are added
 *   to the request as a synthetic Read result. It works anywhere in the message, inside a context
 *   block too. An `@` glued to anything else (`x@y`, `(@y`, `"@y`, or a zero-width space) is left
 *   alone.
 * - **A command.** A message whose first character is `/` runs that slash command, with whatever
 *   shell its definition allows. Only the very first character counts.
 *
 * Sending the text as structured content blocks changes neither (measured too), so the text
 * itself is defused, keeping it readable: a zero-width space (U+200B) goes before each such `@`,
 * and before a leading `/`. The model reads the same words; Claude Code no longer matches them.
 *
 * @module services/runtimes/claude-code/prompt-defuse
 */

/** Invisible, not whitespace to JavaScript or to Claude Code, and kept by both. */
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Put a zero-width space before every `@` Claude Code would read as a file reference: one at
 * the start of the text or straight after whitespace. Idempotent.
 *
 * @param text - Text that is not the person-at-this-computer's own.
 */
export function defuseFileReferences(text: string): string {
  return text.replace(/(^|\s)@/gu, `$1${ZERO_WIDTH_SPACE}@`);
}

/**
 * Words safe to be the user message itself: no file reference, and no leading `/` that would
 * run a command (a `/` after leading whitespace is defused too, since DorkOS trims a command
 * before dispatching it). Idempotent.
 *
 * @param text - The message, when somebody other than the person here wrote it.
 */
export function defuseUntrustedPrompt(text: string): string {
  const safe = defuseFileReferences(text);
  return /^\s*\//u.test(safe) ? `${ZERO_WIDTH_SPACE}${safe}` : safe;
}
