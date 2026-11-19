/**
 * Run a release-branch script's `main` when, and only when, it is the program
 * Node was started with. Paths are compared after resolving symlinks: on macOS
 * `/tmp` and `/var` are links, and a plain string compare there skipped `main`
 * and exited 0 with no verdict, a silent pass (ci-steward, DOR-4639).
 */
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exit code when the script was clearly invoked but could not confirm it is the entry point. */
export const UNCONFIRMED_ENTRY_EXIT = 2;

/**
 * Call `main` if `moduleUrl` is the started program. A thrown error, or a
 * same-named file whose real path cannot be confirmed, exits 2, never 0.
 */
export function runIfMain(moduleUrl: string, main: () => number | void): void {
  const started = process.argv[1];
  if (!started) return;
  const self = fileURLToPath(moduleUrl);
  let same: boolean;
  try {
    same = realpathSync(started) === realpathSync(self);
  } catch {
    same = false;
  }
  if (!same) {
    // Imported by another module: nothing to do. Started under this name but
    // unconfirmed: fail closed rather than print nothing and pass.
    if (basename(started) === basename(self)) {
      console.error(`Could not confirm ${basename(self)} is the program being run.`);
      process.exitCode = UNCONFIRMED_ENTRY_EXIT;
    }
    return;
  }
  try {
    const code = main();
    if (typeof code === 'number') process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = UNCONFIRMED_ENTRY_EXIT;
  }
}
