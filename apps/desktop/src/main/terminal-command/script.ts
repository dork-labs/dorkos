/**
 * The Terminal command's script: a few lines of `sh` at `~/.local/bin/dorkos` that
 * run this app's own `dorkos` command (DOR-3105).
 *
 * It names the app's helper binary and the bundled command by absolute path,
 * never through `PATH` (Security, Nov 11): whatever else is on the person's
 * `PATH`, typing `dorkos` runs this app. Agents can't write the file
 * (`HOME_PERSON_ONLY_PATHS` in the server's protected-paths list).
 *
 * @module main/terminal-command/script
 */

/**
 * The line that marks a script DorkOS wrote. Install only replaces, and Remove only
 * deletes, a file that carries it: anything else at that path is the person's.
 */
export const SCRIPT_MARKER = '# dorkos-terminal-command v1';

/** Where the app's own parts are, read from the running app. */
export interface ScriptTarget {
  /** The app's helper binary, which runs Node code with `ELECTRON_RUN_AS_NODE`. */
  helper: string;
  /** The bundled command, outside the asar (`app.asar.unpacked/dist/cli/dorkos.mjs`). */
  command: string;
}

/** Quote a value for `sh`: single quotes, each inner quote closed, escaped and reopened. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The `exec` line, which is also how a script is matched to this copy of the app. */
function execLine(target: ScriptTarget): string {
  return `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(target.helper)} ${shQuote(target.command)} "$@"`;
}

/**
 * The whole script for this copy of the app.
 *
 * @param target - The app's helper binary and bundled command.
 * @returns The file's text, ending in a newline.
 */
export function terminalCommandScript(target: ScriptTarget): string {
  return [
    '#!/bin/sh',
    SCRIPT_MARKER,
    '# Added by the DorkOS app (Settings > This computer > Terminal command).',
    "# It runs that app's own dorkos command. Remove it there, or delete this file.",
    execLine(target),
    '',
  ].join('\n');
}

/**
 * Whether a file's text is a script DorkOS wrote, of any version.
 *
 * @param text - The file's text.
 */
export function isDorkosScript(text: string): boolean {
  return text.split('\n')[1]?.startsWith('# dorkos-terminal-command ') ?? false;
}

/**
 * Whether a file's text is this version's script for this copy of the app. A copy
 * moved to another folder leaves a script that points at nothing; it reads as not
 * installed, and Install rewrites it.
 *
 * @param text - The file's text.
 * @param target - This app's helper binary and bundled command.
 */
export function runsThisApp(text: string, target: ScriptTarget): boolean {
  return text === terminalCommandScript(target);
}
