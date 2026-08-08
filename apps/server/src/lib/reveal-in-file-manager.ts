/**
 * Show a path in the operating system's file manager, on the machine this
 * server runs on — the "Reveal in Finder" action's one platform-specific step.
 *
 * Every launcher runs through `execFile` with an argument array, never a shell,
 * so a file name containing shell metacharacters travels as data rather than as
 * something to parse. Callers boundary-validate the path first; this module
 * only decides which program to run.
 *
 * @module lib/reveal-in-file-manager
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Launch the platform's file manager with `target` selected — or, where no
 * portable "select this file" exists, with its containing folder open.
 *
 * Rejects when the launcher cannot be started at all; on Windows a non-zero
 * exit is deliberately not treated as a failure, because Explorer exits
 * non-zero even when it opened the window.
 *
 * @param target - Absolute, already boundary-validated path to reveal.
 */
export async function revealInFileManager(target: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', target]);
    return;
  }
  if (process.platform === 'win32') {
    try {
      // `windowsVerbatimArguments` + explicit quoting: Explorer parses its own
      // command line and does not understand the `"/select,C:\a b\c"` form
      // Node's default quoting would produce for a path containing spaces.
      await execFileAsync('explorer.exe', [`/select,"${target}"`], {
        windowsVerbatimArguments: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    }
    return;
  }
  // Linux/BSD desktops have no portable file-selection call — open the folder
  // that contains the entry, which every xdg-compliant file manager handles.
  await execFileAsync('xdg-open', [path.dirname(target)]);
}
