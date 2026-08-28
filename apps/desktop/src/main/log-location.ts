import { app } from 'electron';
import { dirname } from 'node:path';
import log from 'electron-log';

/**
 * Where the shell's own log file is, phrased for a person to go and look.
 *
 * Every "DorkOS couldn't start" box ends by naming the log directory, and for a
 * long time each of them named a **macOS** path in a string literal. On Windows
 * that sentence sent people to a directory that does not exist on their
 * machine, in the one dialog they were already stuck at.
 *
 * The answer is derived rather than branched on `process.platform`, because the
 * path is not simply a platform choice: electron-log writes to
 * `app.getPath('logs')`, which folds in the app name, a relocated home and the
 * OS's own convention (`~/Library/Logs/<app>` on macOS,
 * `%APPDATA%\<app>\logs` on Windows, `~/.config/<app>/logs` on Linux). Asking
 * the transport where it is actually writing answers all of that at once and
 * cannot drift from reality the way a literal did.
 *
 * @module main/log-location
 */

/** What to say when the log directory cannot be resolved at all. */
const UNKNOWN_LOCATION = "DorkOS's log folder";

/**
 * The directory holding `main.log`, or `null` if neither the transport nor
 * Electron will say.
 *
 * Two sources in order of truthfulness: the file the transport has open, then
 * the path electron-log would have derived it from. Both are wrapped because
 * this is only ever called to build the text of a message about something that
 * has already gone wrong — a throw here would replace a diagnosis with a
 * crash.
 */
function resolveLogDirectory(): string | null {
  try {
    return dirname(log.transports.file.getFile().path);
  } catch {
    // The transport has no file — logging to disk is off, or the directory
    // could not be created. Electron still knows where it would have gone.
  }
  try {
    return app.getPath('logs');
  } catch {
    return null;
  }
}

/**
 * The log directory, as a dialog should print it.
 *
 * @returns An absolute path, or a plain-language stand-in when there is none.
 */
export function describeLogLocation(): string {
  return resolveLogDirectory() ?? UNKNOWN_LOCATION;
}
