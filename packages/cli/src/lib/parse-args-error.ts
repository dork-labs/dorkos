/**
 * One place to turn a `node:util` `parseArgs` failure into the message a person
 * actually reads.
 *
 * Every `dorkos` subcommand parses its own argv slice, so every one of them used
 * to carry its own copy of the same eleven-line `catch` block — twenty copies at
 * the last count, all differing only in the command name and the usage string
 * they interpolated. Two of them had already been lifted into per-file helpers,
 * which is what made the duplication easy to see: the extraction was the right
 * idea, it just needed to happen once instead of per file (DOR-169).
 *
 * @module lib/parse-args-error
 */

/**
 * Re-throw a `parseArgs` failure, translating the one case a person can act on.
 *
 * `parseArgs` reports an unknown flag as a `TypeError` whose message names the
 * flag but nothing else — not the command that rejected it, not what it would
 * have accepted. This swaps in a message that says both, and leaves every other
 * failure exactly as it was rather than dressing it up as an option problem.
 *
 * The original `TypeError` rides along as `cause`. The readable message is for
 * the person at the terminal; the `cause` chain is for whoever is reading a log
 * later and needs the parser's own account of what happened.
 *
 * @param err - The value thrown by `parseArgs`, rethrown untouched unless it is
 *   the unknown-option `TypeError`.
 * @param command - The command as a person types it, e.g. `marketplace remove`.
 * @param usage - The usage text to print beneath the error.
 * @returns Never — this function always throws.
 */
export function rethrowUnknownOption(err: unknown, command: string, usage: string): never {
  if (
    err instanceof TypeError &&
    (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  ) {
    const match = err.message.match(/Unknown option '([^']+)'/);
    throw new Error(`Unknown option for '${command}': ${match?.[1] ?? 'unknown'}\n${usage}`, {
      cause: err,
    });
  }
  throw err;
}
