/**
 * What choosing a slash command in the palette puts in the composer.
 *
 * Pure, and its own module, because the rule is easy to get wrong in a way that
 * looks right: **a slash command is only a command at position 0.** Both
 * recognizers anchor there — the client send funnel's `splitSlashCommand` runs
 * `/^\/(\S+)/` over `content.trim()`, and the server's `detectSlashCommandName`
 * runs its own anchored pattern over `content.trimStart()`. Text with a command
 * appended to the end of it is not a command; it is prose, and it reaches the
 * model verbatim while the row that produced it looks like it worked.
 *
 * (The regex in `use-command-palette.ts` that matches a slash word after
 * whitespace is the autocomplete POPUP's trigger — it decides when to offer a
 * menu while typing, and recognizes nothing.)
 *
 * @module features/command-palette/model/palette-command-draft
 */

/**
 * A leading slash-command invocation: `/name` or `/ns:name` at the very start,
 * followed by whitespace or end of input.
 *
 * Mirrors `detectSlashCommandName` in the claude-code message sender, which is
 * the authority — the lookahead is what keeps `/etc/hosts` ordinary text rather
 * than a command called `etc`. The agreement between the two is pinned by the
 * `isNativeCommandContent` assertions in this module's test rather than by
 * this comment.
 */
const LEADING_COMMAND_RE = /^\/([A-Za-z0-9][\w.-]*(?::[\w.-]+)*)(?=\s|$)\s*/;

/**
 * The composer text a chosen slash command should produce.
 *
 * One rule: the command owns position 0, and everything else the person typed
 * stays as its argument.
 *
 * - Empty composer → the command and a trailing space, so the caret sits where
 *   an argument goes.
 * - Ordinary text → the command in front of it. `/compact` chosen over a draft
 *   reading `focus on the API changes` is exactly the
 *   `/compact focus on the API changes` argument form the intent already
 *   supports, so nothing is lost and nothing is invented.
 * - A draft that is ITSELF a command → its command token is replaced and its
 *   arguments kept. Picking a command while one is typed means "this one
 *   instead"; stacking them would hand the old command to the new one as
 *   argument text, which means nothing to either.
 *
 * Text a person typed is never dropped — the only thing this can remove is a
 * command token they just chose to replace.
 *
 * @param command - The chosen command, leading slash included (`/compact`).
 * @param draft - Whatever is already in that conversation's composer.
 * @returns The composer text to write.
 */
export function composeCommandDraft(command: string, draft: string): string {
  const rest = draft.trim().replace(LEADING_COMMAND_RE, '').trim();
  return rest ? `${command} ${rest}` : `${command} `;
}
