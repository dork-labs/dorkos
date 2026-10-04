/**
 * The `allow.run` entry grammar for an extension that runs separately
 * (`serverCapabilities.runtime: "subprocess"`, DOR-2686).
 *
 * Each entry names ONE program, never a command line: a bare program name
 * (`git`), found on the host's `PATH` when DorkOS looks, or an absolute path
 * (`/usr/local/bin/rg`, `C:\Tools\rg.exe`). No arguments, no globs, no
 * relative paths, and no `.` or `..` segments, so the name a person reads on
 * an approval card is the only program it can mean. Pure: nothing here looks
 * at the disk; resolving a name to a file is the server's job.
 *
 * @module extension-api/run-allowlist
 */

/** A bare program name: letters, digits, dots, underscores and hyphens. */
const BARE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The longest entry accepted, in characters. */
const MAX_RUN_ENTRY_LENGTH = 1024;

/** The reason given for an entry that carries arguments or spaces. */
export const RUN_ENTRY_ONE_PROGRAM = 'Name one program, without arguments, like git';

/**
 * Whether an entry is an absolute path (POSIX `/…` or Windows `X:\…`) rather
 * than a bare program name.
 *
 * @param entry - An `allow.run` entry.
 */
export function isAbsoluteProgramPath(entry: string): boolean {
  return entry.startsWith('/') || /^[A-Za-z]:\\/.test(entry);
}

/**
 * Why an `allow.run` entry is refused, or `null` when it is a good one.
 *
 * @param entry - The entry as the manifest wrote it.
 * @returns A reason an extension author can act on, or `null`.
 */
export function runEntryProblem(entry: string): string | null {
  if (typeof entry !== 'string' || entry.length === 0) return 'Name a program, like git';
  if (entry.length > MAX_RUN_ENTRY_LENGTH) return 'This program path is too long';
  if (/\s/.test(entry)) return RUN_ENTRY_ONE_PROGRAM;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(entry)) return RUN_ENTRY_ONE_PROGRAM;
  if (/[*?[\]{}$`;&|<>"'!~%]/.test(entry)) return RUN_ENTRY_ONE_PROGRAM;

  if (entry.startsWith('/')) {
    const segments = entry.slice(1).split('/');
    if (entry.includes('\\')) return 'Use forward slashes in a path like /usr/bin/git';
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return 'Write the full path without "." or ".." parts, like /usr/bin/git';
    }
    return null;
  }
  if (/^[A-Za-z]:\\/.test(entry)) {
    const segments = entry.slice(3).split('\\');
    if (entry.includes('/')) return 'Use backslashes in a path like C:\\Tools\\rg.exe';
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return 'Write the full path without "." or ".." parts, like C:\\Tools\\rg.exe';
    }
    if (segments.some((segment) => segment.includes(':'))) return RUN_ENTRY_ONE_PROGRAM;
    return null;
  }
  if (entry.includes('/') || entry.includes('\\')) {
    return 'Use a program name like git, or a full path like /usr/bin/git';
  }
  if (entry === '.' || entry === '..' || !BARE_NAME.test(entry)) {
    return 'Use a program name like git, or a full path like /usr/bin/git';
  }
  return null;
}
