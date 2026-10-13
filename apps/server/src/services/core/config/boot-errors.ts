import { adviceFor } from './load-error-advice.js';
import { unreadableMessage } from './unreadable-message.js';

/**
 * A reason DorkOS stopped instead of touching somebody's settings.
 *
 * Every subclass means the same thing to a caller — print the message, stop —
 * and both entry points (`apps/server/src/index.ts` and the CLI) branch on this
 * base rather than on the individual classes, so a new reason to refuse cannot
 * arrive as an uncaught stack trace.
 *
 * The message is written for the person reading a terminal, because that is
 * where it lands. The underlying failure travels as `cause`.
 */
export abstract class ConfigBootError extends Error {
  /** Absolute path of the config file this is about. */
  readonly configPath: string;

  /**
   * What the person can actually do about it, as a paragraph of its own.
   *
   * Split out so `dorkos doctor` can show the same next step on its checklist
   * without restating it. Two copies of this advice drifted apart once already.
   */
  readonly advice: string;

  /**
   * Build one, from a message a subclass has already written.
   *
   * @param message - The whole terminal message, advice included.
   * @param configPath - Absolute path of the config file.
   * @param advice - The next step, repeated on doctor's checklist.
   * @param cause - The failure being reported.
   */
  protected constructor(message: string, configPath: string, advice: string, cause: unknown) {
    super(message, { cause });
    this.configPath = configPath;
    this.advice = advice;
  }
}

/**
 * Raised when the operating system would not let DorkOS read the config file,
 * after retrying.
 *
 * @see {@link unreadableMessage} for why there are two of them.
 */
export class ConfigUnreadableError extends ConfigBootError {
  /**
   * Build the message a person sees when their settings could not be read.
   *
   * @param configPath - Absolute path of the config file.
   * @param cause - The last failure from the `Conf` constructor.
   * @param backupPath - Where the old settings were copied, when this happened
   *   on the second leg of corrupt-recovery and the original is already gone.
   */
  constructor(configPath: string, cause: unknown, backupPath?: string) {
    const advice = adviceFor(cause, configPath, backupPath);
    super(
      unreadableMessage(configPath, formatConfigLoadError(cause), advice, backupPath),
      configPath,
      advice,
      cause
    );
    this.name = 'ConfigUnreadableError';
  }
}

/**
 * Raised when one of DorkOS's own migration bodies threw while updating a
 * config file to this version.
 *
 * The file is not the problem here, so it is not touched — not backed up, not
 * replaced, not deleted. This is the same rule the errno class follows, applied
 * one layer up: DorkOS's code was wrong, and a person's settings must not pay
 * for that. Whoever ships the fix boots straight back into them.
 */
export class ConfigMigrationFailedError extends ConfigBootError {
  /**
   * Build the message a person sees when an update to their settings failed.
   *
   * @param configPath - Absolute path of the config file.
   * @param cause - The failure `conf` wrapped and rethrew.
   */
  constructor(configPath: string, cause: unknown) {
    const advice =
      `Nothing you can change in that file will help, because the problem is in\n` +
      `DorkOS. Start the version you were using before, or install a newer one.\n` +
      `If you would rather not wait, rename the file: DorkOS will make a new one\n` +
      `and your settings stay in the file you renamed.`;
    super(
      [
        `DorkOS could not update your settings to this version, so it stopped`,
        `rather than replacing them.`,
        ``,
        `  file: ${configPath}`,
        `  why:  ${formatConfigLoadError(cause)}`,
        ``,
        `DorkOS did not replace or delete your settings.`,
        advice,
      ].join('\n'),
      configPath,
      advice,
      cause
    );
    this.name = 'ConfigMigrationFailedError';
  }
}

/**
 * One line describing a load failure, for a log or an error message.
 *
 * Node's `fs` errors already begin with their errno code
 * (`EMFILE: too many open files, open '…'`), so the message alone is the whole
 * story for the case this exists to report.
 *
 * @param error - Whatever was thrown.
 */
export function formatConfigLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
