import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Resolve the DorkOS data directory with environment-aware defaults.
 *
 * Priority:
 *  1. `DORK_HOME` env var — explicit override, wins in any environment
 *  2. `.temp/.dork/` relative to `cwd` — dev default (keeps project-local state out of `~`)
 *  3. `~/.dork/` — production default
 *
 * The resolved value is set on `process.env.DORK_HOME` during server startup
 * so that all downstream services can read it without re-running this logic.
 */
export function resolveDorkHome(): string {
  if (process.env.DORK_HOME) return process.env.DORK_HOME;
  if (process.env.NODE_ENV !== 'production') {
    return path.join(process.cwd(), '.temp', '.dork');
  }
  return path.join(os.homedir(), '.dork');
}

/**
 * Whether a folder really sits inside the data directory. Compares real paths,
 * so a symlink inside it that leads back out does not count, and neither does
 * the data directory itself (`DORK_HOME` set to the real home). A folder that
 * cannot be resolved does not count either: this answers "safe to read", so an
 * unknown is a no.
 *
 * @param folder - The folder to test.
 * @param dorkHome - The data directory.
 */
export function sitsInsideDorkHome(folder: string, dorkHome: string): boolean {
  try {
    const relative = path.relative(
      fs.realpathSync.native(dorkHome),
      fs.realpathSync.native(folder)
    );
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

/**
 * Whether this process's home directory sits inside the data directory: the mark
 * of a throwaway test home (DOR-3587). Here because this file is one of the
 * `os.homedir()` carve-outs.
 *
 * @param dorkHome - The data directory.
 */
export function homeSitsInsideDorkHome(dorkHome: string): boolean {
  return sitsInsideDorkHome(os.homedir(), dorkHome);
}
