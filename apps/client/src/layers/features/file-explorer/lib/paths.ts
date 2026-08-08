/**
 * Path presentation helpers for the explorer's copy/reveal actions.
 *
 * These format paths for a PERSON to read or paste elsewhere — they never feed
 * a transport call, which always takes the stored `cwd`-relative path. The
 * separator follows the server's machine, not the browser's: the cockpit is
 * often a browser on one OS talking to a server on another, and a Windows path
 * pasted with forward slashes is not the path the user asked for.
 *
 * @module features/file-explorer/lib/paths
 */

/**
 * The label for the "reveal this in the OS file manager" action, named after
 * the file manager the SERVER's platform actually ships — that is the machine
 * the window opens on.
 *
 * @param platform - `ServerConfig.platform` (e.g. `'darwin-arm64'`), or undefined before config loads.
 */
export function revealActionLabel(platform: string | undefined): string {
  if (platform?.startsWith('darwin')) return 'Reveal in Finder';
  if (platform?.startsWith('win32')) return 'Reveal in File Explorer';
  return 'Show in File Manager';
}

/**
 * Join a working directory with a `cwd`-relative entry path into the absolute
 * path as the server's OS spells it.
 *
 * @param cwd - The session working directory (absolute, in the server's own form).
 * @param relPath - Entry path relative to `cwd`, always POSIX-separated on the wire.
 */
export function toAbsolutePath(cwd: string, relPath: string): string {
  // A Windows path is the one that uses backslashes and has no forward slash to
  // contradict it; everything else (including UNC-free POSIX paths) is POSIX.
  const isWindows = cwd.includes('\\') && !cwd.includes('/');
  const base = cwd.replace(/[\\/]+$/, '');
  const tail = isWindows ? relPath.split('/').join('\\') : relPath;
  return `${base}${isWindows ? '\\' : '/'}${tail}`;
}
