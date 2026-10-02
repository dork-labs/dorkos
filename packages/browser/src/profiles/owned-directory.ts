import { lstatSync, realpathSync } from 'node:fs';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Exact owned-directory identity, retained before any browser acquisition. */
export interface OwnedDirectory {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
/** Bind the real private directory; a later path replacement never inherits ownership. */
export function ownDirectory(path: string): OwnedDirectory {
  const entry = lstatSync(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (entry.mode & 0o077) !== 0 ||
    (process.getuid && entry.uid !== process.getuid())
  )
    throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  return Object.freeze({ path, dev: entry.dev, ino: entry.ino });
}
/** Verify unchanged identity immediately before release/removal, rather than trusting a string path. */
export function assertDirectory(owner: OwnedDirectory): void {
  let current: OwnedDirectory;
  try {
    current = ownDirectory(owner.path);
  } catch {
    throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
  }
  if (current.dev !== owner.dev || current.ino !== owner.ino)
    throw new BrowserLifecycleError('PROFILE_UNCERTAIN');
}
