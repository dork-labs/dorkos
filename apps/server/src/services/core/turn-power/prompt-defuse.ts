/**
 * Words from somebody who is not the person at this computer, made safe to hand Claude Code as
 * words (DOR-2955).
 *
 * Claude Code acts on two things in a user message before any tool runs, so neither the
 * permission mode nor a `PreToolUse` hook ever sees them (measured on the pinned binary, SDK
 * 0.3.280, against a mock endpoint):
 *
 * - **A file reference.** An `@` followed by a path (`@/etc/hosts`, `@~/…`, `@notes.md`,
 *   `@"a path"`) is read and its contents are added to the request as a synthetic Read result.
 *   The same parser takes `@agent-…` and `@server:uri`. It works anywhere in the message, inside
 *   a context block too. The binary's own rule for where one may start is
 *   `(^|[\s。、？！])@`: after whitespace, AND after the CJK full stop and comma and the
 *   full-width question and exclamation marks.
 * - **A command.** A message whose first character is `/` runs that slash command, with whatever
 *   shell its definition allows. Only the very first character counts.
 *
 * Sending the text as structured content blocks changes neither (measured too), so the text
 * itself is defused, keeping it readable: a zero-width space (U+200B) goes before EVERY `@`, and
 * before a leading `/`. The model reads the same words; Claude Code no longer matches them.
 *
 * **Every `@`, not the ones the parser is known to take.** Matching its start set was tried and
 * missed four characters the binary also accepts; a set copied from one release is a guess about
 * the next. A zero-width space before every `@` holds whatever precedes it. The cost is an
 * invisible character in an address or a package name the model reads, which it reads past.
 *
 * Defused text goes to the model only: nothing in DorkOS parses mentions or commands out of it
 * afterwards (room mentions are resolved from the room entry, which keeps the words as written).
 *
 * @module services/core/turn-power/prompt-defuse
 */

/** Invisible, not whitespace to JavaScript or to Claude Code, and kept by both. */
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Put a zero-width space before every `@` that does not already have one, so Claude Code reads
 * none of them as a file, agent or resource reference. Idempotent.
 *
 * @param text - Text that is not the person-at-this-computer's own.
 */
export function defuseFileReferences(text: string): string {
  return text.replace(/(?<!\u200B)@/gu, `${ZERO_WIDTH_SPACE}@`);
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
