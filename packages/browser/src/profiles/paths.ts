import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Create or verify an owned private directory without following a poisoned leaf. */
export function privateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = lstatSync(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    entry.uid !== process.getuid?.()
  )
    throw new BrowserLifecycleError('UNSAFE_DIRECTORY');
}

/** Canonicalize an injected root while refusing symlink leaves and public directories. */
export function prepareDataRoot(dataDir: string): string {
  privateDirectory(dataDir);
  const root = realpathSync(dataDir);
  for (const name of ['profiles', 'ephemeral', 'reservations']) privateDirectory(join(root, name));
  return root;
}
