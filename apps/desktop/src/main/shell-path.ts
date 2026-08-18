import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import log from 'electron-log';
import { LOGIN_SHELL_PATH_MARKER } from '../shared/login-shell-path';

/**
 * Giving the server child the PATH the user actually has.
 *
 * An app started from Finder, the Dock or Spotlight is started by launchd, not
 * by a shell — so it inherits launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing else. None of the places developer tools actually live are on it:
 * not `~/.local/bin`, not `/opt/homebrew/bin`, not any `~/.nvm/versions/...`.
 * The server checks for `claude`, `codex` and `opencode` by looking them up on
 * PATH, so in a packaged app every one of those checks failed for anyone whose
 * tools were not bundled — while the same DorkOS started from a terminal found
 * them all (DOR-1335). Nothing about the tools was different; only the PATH was.
 *
 * The fix is the one every GUI developer tool on macOS ends up with: ask the
 * user's own login shell what its PATH is, and put that in front of the one
 * launchd handed down. Interactively (`-i`), because plenty of people export
 * PATH from `~/.zshrc`, which a non-interactive shell never reads.
 *
 * Three properties make that safe to do on the start-up path:
 *
 * - **Once per process.** The server child is re-spawned on every crash
 *   recovery, and a shell start-up per restart would be seconds of delay for an
 *   answer that cannot have changed.
 * - **Bounded, and killed if it hangs.** An rc file that waits for input would
 *   otherwise stop the app from ever starting.
 * - **Never fatal.** Every failure path falls back to the inherited PATH and
 *   says why in the log. A worse PATH is a degraded app; no app is not.
 *
 * Skipped entirely in dev (the terminal's PATH is already inherited, and asking
 * a shell would only add start-up latency to every `pnpm dev:desktop`) and on
 * Windows, which has no login-shell equivalent to read.
 *
 * @module main/shell-path
 */

/**
 * The one command run in the user's shell.
 *
 * `${PATH}` is braced deliberately: `_` is a valid identifier character, so a
 * bare `$PATH` immediately followed by the marker would be read as a variable
 * named `PATH__dorkos_path__` and expand to nothing.
 */
const PROBE_SCRIPT = `printf %s "${LOGIN_SHELL_PATH_MARKER}\${PATH}${LOGIN_SHELL_PATH_MARKER}"`;

/**
 * How long the shell gets to answer.
 *
 * Generous against a cold, plugin-heavy `~/.zshrc` (oh-my-zsh with a dozen
 * plugins is a few hundred milliseconds; a first run after an update can be
 * more), and short enough that a shell which will never answer costs one
 * bounded pause rather than an app that never opens.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** How many resolved entries to name in the log line, so it stays one line. */
const LOGGED_ENTRIES = 3;

/**
 * The login shell's PATH, or `null` if it could not be had. `undefined` means
 * nobody has asked yet — see the "once per process" note in the module doc.
 */
let cachedShellPath: string | null | undefined;

/** Split a PATH into its entries, dropping the empty ones a stray `:` leaves. */
function splitPath(value: string): string[] {
  return value.split(':').filter((entry) => entry !== '');
}

/**
 * Whether a string is plausibly a PATH.
 *
 * The bar is one absolute entry. A shell that answered with nothing, or with
 * only relative entries, has produced something that would make the app worse
 * than launchd's four system directories — so it is treated as a failure rather
 * than used.
 *
 * @param value - The candidate PATH.
 */
function looksLikeAPath(value: string): boolean {
  return splitPath(value).some((entry) => entry.startsWith('/'));
}

/**
 * Pull the marked PATH out of everything the shell printed.
 *
 * @param stdout - The shell's complete stdout.
 * @returns The PATH between the markers, or `null` when it is not there.
 */
function extractMarkedPath(stdout: string): string | null {
  const start = stdout.indexOf(LOGIN_SHELL_PATH_MARKER);
  if (start === -1) return null;
  const valueStart = start + LOGIN_SHELL_PATH_MARKER.length;
  const end = stdout.indexOf(LOGIN_SHELL_PATH_MARKER, valueStart);
  if (end === -1) return null;
  return stdout.slice(valueStart, end);
}

/**
 * Ask the user's login shell for its PATH.
 *
 * `stderr` is captured but never read as a failure: rc files write to it
 * routinely (a missing iTerm integration file, a deprecation notice), and none
 * of it says anything about whether the answer is good. The exit status and the
 * marked value do.
 *
 * @returns The shell's PATH, or `null` with a logged reason.
 */
function readLoginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) {
    log.warn(
      '[server] SHELL is not set, so DorkOS cannot read your login PATH. Tools installed ' +
        'outside /usr/bin may not be found.'
    );
    return null;
  }

  const result = spawnSync(shell, ['-ilc', PROBE_SCRIPT], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    // stdin closed, not inherited: an rc file that reads from a terminal would
    // otherwise sit there until the timeout kills it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const complain = (reason: string): null => {
    log.warn(
      `[server] Could not read the PATH from ${shell} (${reason}), so DorkOS is using the ` +
        'PATH it was started with. Tools installed outside /usr/bin may not be found.'
    );
    return null;
  };

  if (result.error) {
    return complain(
      result.signal ? `it did not answer within ${PROBE_TIMEOUT_MS}ms` : result.error.message
    );
  }
  if (result.status !== 0) return complain(`it exited with code ${String(result.status)}`);

  const extracted = extractMarkedPath(result.stdout ?? '');
  if (extracted === null) return complain('it printed no PATH');
  if (!looksLikeAPath(extracted)) return complain('what it printed does not look like a PATH');
  return extracted;
}

/**
 * Compose the PATH the server child should run with.
 *
 * Resolved entries first, then any inherited entry the shell did not mention.
 * Order matters and this order is the deliberate one: the shell's PATH is the
 * user's own preference list, including which `node` or `claude` wins when
 * several are installed, so it has to be able to shadow the system copies.
 * Nothing inherited is dropped, because launchd's entries are where the system
 * tools are and the shell's answer is additive, not a replacement.
 *
 * @param resolved - The login shell's PATH.
 * @param inherited - The PATH this process was started with.
 */
function mergePaths(resolved: string, inherited: string | undefined): string {
  const entries: string[] = [];
  for (const entry of [...splitPath(resolved), ...splitPath(inherited ?? '')]) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.join(':');
}

/**
 * The PATH to hand the server child.
 *
 * @param inheritedPath - This process's own `PATH`, as launched.
 * @returns The merged PATH, or `inheritedPath` unchanged whenever the probe is
 *   skipped (dev, Windows) or could not produce a usable answer.
 */
export function resolveChildPath(inheritedPath: string | undefined): string | undefined {
  if (!app.isPackaged || process.platform === 'win32') return inheritedPath;

  if (cachedShellPath === undefined) {
    cachedShellPath = readLoginShellPath();
    if (cachedShellPath !== null) {
      const entries = splitPath(cachedShellPath);
      log.info(
        `[server] Read ${entries.length} PATH entries from ${process.env.SHELL}, starting ` +
          `${entries.slice(0, LOGGED_ENTRIES).join(', ')}`
      );
    }
  }

  if (cachedShellPath === null) return inheritedPath;
  return mergePaths(cachedShellPath, inheritedPath);
}
