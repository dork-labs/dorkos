/**
 * Ask a new login shell what it runs for `dorkos`, the way a new Terminal window
 * would (DOR-3105). Same shape as `shell-path.ts`: `-ilc`, a hard timeout, stdin
 * closed, and the answer cut out from between two markers so whatever the
 * person's startup files print around it is ignored.
 *
 * @module main/terminal-command/probe
 */
import { execFile } from 'node:child_process';
import type { ShellLine } from './shell-line';

const MARKER = '__DORKOS_TERMINAL_COMMAND__';
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The script for one shell. `command -v` prints an alias's definition in zsh and
 * bash; fish keeps aliases as functions, so it prints the function instead.
 *
 * @param shell - Which shell runs it.
 */
export function probeScript(shell: ShellLine['shell']): string {
  const ask =
    shell === 'fish'
      ? 'if functions -q dorkos; functions dorkos; else; command -v dorkos; end'
      : 'command -v dorkos';
  return `printf '%s' '${MARKER}'; ${ask}; printf '%s' '${MARKER}'`;
}

/**
 * The text between the markers, or null when the shell never got that far.
 *
 * @param stdout - Everything the shell printed.
 */
export function probeAnswer(stdout: string): string | null {
  const start = stdout.indexOf(MARKER);
  if (start === -1) return null;
  const end = stdout.indexOf(MARKER, start + MARKER.length);
  if (end === -1) return null;
  return stdout.slice(start + MARKER.length, end).trim();
}

/**
 * Run the probe in the person's login shell.
 *
 * @param loginShell - `$SHELL`; without one there is nothing to ask.
 * @param line - The person's shell, from {@link ShellLine}.
 * @returns What it runs for `dorkos` ('' for nothing), or null when it couldn't be asked.
 */
export function findDorkosInLoginShell(
  loginShell: string | undefined,
  line: ShellLine
): Promise<string | null> {
  if (!loginShell) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      loginShell,
      ['-ilc', probeScript(line.shell)],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 20 },
      // `command -v` exits 1 when nothing is found: read the markers, not the exit code.
      (_error, stdout) => resolve(probeAnswer(String(stdout ?? '')))
    );
    child.stdin?.end();
  });
}
