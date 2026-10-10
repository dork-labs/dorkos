/**
 * The next step a person is offered when DorkOS could not read its own config
 * file, chosen by what the operating system said. Split out of
 * `config-manager.ts`, which builds the errors that carry it.
 *
 * @module services/core/config/boot-advice
 */
import path from 'path';

/** A bare errno code as Node writes it: `EMFILE`, `EACCES`, `EIO`. */
export const ERRNO_CODE = /^E[A-Z0-9]+$/;

/**
 * The same code as it appears at the head of an `fs` error's message, e.g.
 * `EMFILE: too many open files, open '/…'`.
 */
export const ERRNO_IN_MESSAGE = /(?:^|\s)E[A-Z0-9]{2,}: /;

/**
 * Errno codes that pass on their own, given a moment.
 *
 * The distinction is the whole point of {@link adviceFor}: "try again" is good
 * advice for a machine that ran out of descriptors and terrible advice for a
 * file the person is not allowed to open, where it means "loop forever".
 */
const SELF_CLEARING_ERRNOS = new Set([
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EAGAIN',
  'EINTR',
  'EIO',
  'ETIMEDOUT',
  'ENOMEM',
]);

/** Errno codes that mean the person, not the machine, has to do something. */
const PERMISSION_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Errno codes that mean there is nowhere to put the bytes.
 *
 * Separate from the permission set because the fix is different and the rename
 * hatch is useless: renaming the file does not let DorkOS write a new one when
 * the disk is full. Reachable through the backup copy on the recovery path.
 */
const NO_SPACE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EFBIG']);

/**
 * The errno behind a failure, whether it is on the error or only in its text.
 *
 * @param cause - The failure to read a code out of.
 * @returns The code, or `undefined` when there is none to find.
 */
function errnoOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const code = (cause as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && ERRNO_CODE.test(code)) return code;
  return ERRNO_IN_MESSAGE.exec(cause.message)?.[0].trim().replace(':', '');
}

/**
 * The next step to offer, chosen by what the operating system actually said.
 *
 * Every branch names something a person can do. "Check that you can open that
 * file" was the old text, and it names no action at all.
 *
 * Two things this must not do. It must not point at a line by position: the
 * same string is shown under three different layouts (with a backup, without
 * one, and as a `dorkos doctor` row), and "the line above" is a different line
 * in each. And when `backupPath` is set it must not offer the rename hatch,
 * because on that path the person's settings are in the BACKUP and the file
 * they would be renaming is the failed replacement, which keeps nothing.
 *
 * @param cause - The failure being reported.
 * @param configPath - Absolute path of the config file.
 * @param backupPath - Where the old settings already went, if they did.
 */
export function adviceFor(cause: unknown, configPath: string, backupPath?: string): string {
  const code = errnoOf(cause);
  if (code !== undefined && SELF_CLEARING_ERRNOS.has(code)) {
    return (
      `This usually means the file was busy, or your computer had too many\n` +
      `files open at once. Both pass on their own, so start DorkOS again.`
    );
  }
  if (code !== undefined && NO_SPACE_ERRNOS.has(code)) {
    return (
      `There is no room left to write the file. Free up some disk space, then\n` +
      `start DorkOS again.`
    );
  }
  if (code !== undefined && PERMISSION_ERRNOS.has(code)) {
    const fix =
      `DorkOS is not allowed to open that file, and waiting will not change\n` +
      `that. Give yourself permission to read and write it (on a Mac or Linux:\n` +
      `chmod u+rw "${configPath}"; on Windows, right-click the file, then\n` +
      `Properties and Security).`;
    if (backupPath !== undefined) return `${fix} Then start DorkOS again.`;
    return (
      `${fix} If you would rather start fresh, rename the file. DorkOS will\n` +
      `make a new one, and your old settings stay in the file you renamed.`
    );
  }
  if (backupPath !== undefined) {
    // Named and actionable, like the permission branch above it: the failure
    // here is a file that could not be CREATED, so the folder is the subject.
    return (
      `DorkOS could not create a file in this folder:\n\n` +
      `  ${path.dirname(configPath)}\n\n` +
      `Give yourself permission to write there (on a Mac or Linux:\n` +
      `chmod u+w "${path.dirname(configPath)}"; on Windows, right-click the\n` +
      `folder, then Properties and Security). Then start DorkOS again.`
    );
  }
  return (
    `That is unlikely to fix itself. If you cannot clear the problem named\n` +
    `above, rename the file and DorkOS will make a new one, keeping your old\n` +
    `settings in the file you renamed.`
  );
}
