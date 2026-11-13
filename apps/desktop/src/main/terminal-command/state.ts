/**
 * Install, remove and read the Terminal command (DOR-3105): the designer's five
 * states, worked out fresh every time Settings asks (no caching).
 *
 * The script goes in `~/.local/bin`: no admin password, nothing system-wide.
 * Install only ever replaces a script DorkOS wrote, and Remove only deletes one,
 * so a person's own file at that path is never touched.
 *
 * @module main/terminal-command/state
 */
import { constants } from 'node:fs';
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDorkosScript, runsThisApp, terminalCommandScript, type ScriptTarget } from './script';
import { shellLineFor, type ShellLine } from './shell-line';

/** Where the script goes, in `~` form for display. */
export const SCRIPT_DISPLAY_PATH = '~/.local/bin/dorkos';

/**
 * The row's state. Mirrored in the client as `TerminalCommandStatus`
 * (`apps/client/src/vite-env.d.ts`).
 */
export type TerminalCommandStatus =
  /** Not this computer's Mac app (a dev build, or Windows for now). The row is hidden. */
  | { state: 'unavailable' }
  /** State 1. */
  | { state: 'not-installed' }
  /** State 2: installed, and Terminal finds it. */
  | { state: 'installed'; path: string }
  /** State 3: installed, but Terminal finds no `dorkos`. */
  | { state: 'not-found'; path: string; shellFile: string; line: string }
  /** State 4: installed, but Terminal finds another `dorkos` first. */
  | {
      state: 'shadowed';
      path: string;
      shellFile: string;
      line: string;
      otherPath: string;
      otherVersion: string | null;
    };

/** What Install and Remove answer: the new state, or state 5's plain reason. */
export type TerminalCommandResult =
  { ok: true; status: TerminalCommandStatus } | { ok: false; message: string };

/** The machine pieces, swapped for fakes in tests. */
export interface TerminalCommandDeps {
  /** The person's home folder. */
  home: string;
  /** This app's helper binary and bundled command, or null when it has none. */
  target: ScriptTarget | null;
  /** `$SHELL`. */
  loginShell: string | undefined;
  /**
   * What the person's own Terminal runs for `dorkos`: `command -v dorkos` in a new
   * login shell (an alias's definition, a path, or '' for none), or null when the
   * shell couldn't be asked.
   */
  findDorkos: (line: ShellLine) => Promise<string | null>;
}

const MAX_SCRIPT_BYTES = 64 * 1024;

function scriptFile(home: string): string {
  return path.join(home, '.local', 'bin', 'dorkos');
}

/** The file's text if it is a plain file DorkOS could have written; `foreign` for anything else. */
async function readScript(file: string): Promise<string | 'absent' | 'foreign'> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return 'foreign';
    const text = await readFile(file, 'utf8');
    return isDorkosScript(text) ? text : 'foreign';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** The `dorkos` package version beside another install, read from disk: nothing is run. */
async function versionNear(other: string): Promise<string | null> {
  let folder = path.dirname(await realpath(other).catch(() => other));
  for (let step = 0; step < 5; step++) {
    try {
      const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === 'dorkos' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No readable package file here: look one folder up.
    }
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return null;
}

/** An alias's target from `command -v` (`alias dorkos='…'`) or fish's `functions` output. */
function aliasTarget(found: string): string | null {
  const posix = /^alias dorkos=(['"]?)(.*)\1$/.exec(found);
  if (posix) return posix[2] ?? '';
  if (/^function dorkos\b/m.test(found) || /^# Defined via/m.test(found))
    return /(\S*\.local\/bin\/dorkos)\b/.exec(found)?.[1] ?? found.split('\n')[0]!;
  return null;
}

/**
 * Read the row's state.
 *
 * @param deps - See {@link TerminalCommandDeps}.
 */
export async function readTerminalCommand(
  deps: TerminalCommandDeps
): Promise<TerminalCommandStatus> {
  if (!deps.target) return { state: 'unavailable' };
  const file = scriptFile(deps.home);
  const text = await readScript(file);
  if (text === 'absent' || text === 'foreign' || !runsThisApp(text, deps.target))
    return { state: 'not-installed' };
  const line = shellLineFor(deps.loginShell);
  const found = (await deps.findDorkos(line))?.trim();
  // A shell that couldn't be asked tells us nothing; don't send the person to edit a file.
  if (found === undefined) return { state: 'installed', path: SCRIPT_DISPLAY_PATH };
  const advice = { path: SCRIPT_DISPLAY_PATH, shellFile: line.file, line: line.line };
  if (found === '') return { state: 'not-found', ...advice };
  const alias = aliasTarget(found);
  if (alias !== null) {
    return alias.endsWith('.local/bin/dorkos')
      ? { state: 'installed', path: SCRIPT_DISPLAY_PATH }
      : { state: 'shadowed', ...advice, otherPath: alias, otherVersion: null };
  }
  const [mine, theirs] = await Promise.all([
    realpath(file).catch(() => file),
    realpath(found).catch(() => found),
  ]);
  if (mine === theirs) return { state: 'installed', path: SCRIPT_DISPLAY_PATH };
  return { state: 'shadowed', ...advice, otherPath: found, otherVersion: await versionNear(found) };
}

/** A failure's plain reason; never a raw error code. */
function reasonFor(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return 'DorkOS can’t write to ~/.local/bin.';
  if (code === 'ENOSPC') return 'the disk is full.';
  return 'something went wrong writing the file.';
}

/**
 * Write the script, replacing only one DorkOS wrote.
 *
 * @param deps - See {@link TerminalCommandDeps}.
 */
export async function installTerminalCommand(
  deps: TerminalCommandDeps
): Promise<TerminalCommandResult> {
  if (!deps.target) return { ok: false, message: 'the Terminal command comes with the Mac app.' };
  const file = scriptFile(deps.home);
  const taken = {
    ok: false,
    message: `another file is already at ${SCRIPT_DISPLAY_PATH}.`,
  } as const;
  try {
    const existing = await readScript(file);
    if (existing === 'foreign') return taken;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    // Written beside it first, so Terminal never runs half a file.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, terminalCommandScript(deps.target), {
      mode: 0o755,
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    try {
      // Only our own script is renamed over. A fresh install links instead, which fails
      // rather than replace a file someone put there after the check above.
      if (existing === 'absent') await placeNew(temp, file);
      else await rename(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return taken;
      throw err;
    } finally {
      await rm(temp, { force: true });
    }
  } catch (err) {
    return { ok: false, message: reasonFor(err) };
  }
  return { ok: true, status: await readTerminalCommand(deps) };
}

/**
 * Put a new script in place without ever replacing what is there: a hard link fails with
 * `EEXIST` when the name is taken, where a rename would silently replace it. The temp
 * file is the caller's to remove.
 *
 * @param temp - The finished script, beside its final name.
 * @param file - Where it goes.
 */
export async function placeNew(temp: string, file: string): Promise<void> {
  await link(temp, file);
}

/**
 * Delete the script, only if DorkOS wrote it.
 *
 * @param deps - See {@link TerminalCommandDeps}.
 */
export async function removeTerminalCommand(
  deps: TerminalCommandDeps
): Promise<TerminalCommandResult> {
  const file = scriptFile(deps.home);
  try {
    const text = await readScript(file);
    if (text === 'foreign')
      return {
        ok: false,
        message: `the file at ${SCRIPT_DISPLAY_PATH} isn’t the one DorkOS added.`,
      };
    if (text !== 'absent') await rm(file);
  } catch (err) {
    return { ok: false, message: reasonFor(err) };
  }
  return { ok: true, status: await readTerminalCommand(deps) };
}
