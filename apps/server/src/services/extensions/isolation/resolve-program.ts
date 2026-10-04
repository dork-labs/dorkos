/**
 * Find the program an `allow.run` entry names on this computer (DOR-2686).
 *
 * Discovery calls this to show a person, before they approve, exactly which
 * file each entry means; the program broker (a later phase) refuses an entry
 * this answers `null` for. It only ever looks at the disk. Nothing is run,
 * and no shell is involved.
 *
 * ## Deterministic on purpose
 *
 * A `which`-style lookup has three surprises, and each is closed here:
 *
 * - **Relative `PATH` folders.** An empty `PATH` entry, `.`, or any relative
 *   folder means "the current directory" to a shell, so the program found
 *   would depend on where the server happened to start. Only absolute `PATH`
 *   folders are searched.
 * - **The current directory on Windows.** `cmd.exe` searches it before
 *   `PATH`; this never does.
 * - **A program an extension could write.** A file inside an extension data
 *   folder (`{dorkHome}/extension-data/…` or a project's
 *   `.dork/extension-data/…`) is skipped, whether reached by `PATH`, by an
 *   absolute entry, or through a symbolic link, because an isolated extension
 *   can write there: allowing it would let one write a program and then run
 *   it.
 *
 * An absolute entry is kept as written when it is a runnable file. A bare
 * name is looked up folder by folder, first match wins; on Windows each
 * `PATHEXT` extension is tried in order unless the name already has one.
 *
 * @module services/extensions/isolation/resolve-program
 */
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { isAbsoluteProgramPath, runEntryProblem } from '@dorkos/extension-api';

/** `PATHEXT` when the environment does not set one, as Windows ships it. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** What {@link resolveProgram} needs to know about the computer. */
export interface ResolveProgramOptions {
  /** DorkOS's data directory: programs under its `extension-data` are refused. */
  dorkHome: string;
  /** The environment whose `PATH` (and `PATHEXT`) is searched. Defaults to the server's. */
  env?: NodeJS.ProcessEnv;
  /** The platform the rules follow. Defaults to the server's. */
  platform?: NodeJS.Platform;
}

/**
 * The path module for a platform, so a Windows lookup is testable on POSIX
 * and the other way round.
 *
 * @param platform - The platform.
 */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Whether a resolved file sits inside a folder an extension can write.
 *
 * @param real - The file's real path.
 * @param dorkHome - DorkOS's data directory, real path.
 * @param p - The platform's path module.
 */
function isExtensionWritable(real: string, dorkHome: string, p: typeof path.posix): boolean {
  const dataRoot = p.join(dorkHome, 'extension-data');
  const rel = p.relative(dataRoot, real);
  if (rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))) return true;
  const segments = real.split(/[\\/]+/);
  return segments.some((segment, i) => segment === '.dork' && segments[i + 1] === 'extension-data');
}

/**
 * The real path of a file, or `null` when it cannot be read.
 *
 * @param target - The path.
 */
async function realOf(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Whether `candidate` is a file this computer would run: a regular file
 * (links followed) with an execute bit on POSIX, or with a `PATHEXT`
 * extension on Windows, and not inside an extension data folder.
 *
 * @param candidate - An absolute path.
 * @param exts - Lowercase `PATHEXT` extensions (Windows).
 * @param dorkHomeReal - DorkOS's data directory, real path.
 * @param platform - The platform.
 */
async function isRunnable(
  candidate: string,
  exts: readonly string[],
  dorkHomeReal: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  const p = pathFor(platform);
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return false;
    if (platform === 'win32') {
      if (!exts.includes(p.extname(candidate).toLowerCase())) return false;
    } else {
      await fs.access(candidate, fsConstants.X_OK);
    }
  } catch {
    return false;
  }
  const real = await realOf(candidate);
  if (!real) return false;
  return !isExtensionWritable(real, dorkHomeReal, p);
}

/**
 * Find the program one `allow.run` entry names on this computer.
 *
 * @param entry - The entry as the manifest wrote it.
 * @param options - DorkOS's data directory, and optionally the environment
 *   and platform to follow.
 * @returns The absolute path of the program, or `null` when there is no
 *   runnable file for it here (or the entry is not a valid one).
 */
export async function resolveProgram(
  entry: string,
  options: ResolveProgramOptions
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  // eslint-disable-next-line no-restricted-syntax -- PATH and PATHEXT are the live lookup environment, not app config
  const env = options.env ?? process.env;
  const p = pathFor(platform);
  if (runEntryProblem(entry)) return null;
  const dorkHomeReal = (await realOf(options.dorkHome)) ?? p.resolve(options.dorkHome);
  const exts = (platform === 'win32' ? (env.PATHEXT ?? env.Pathext ?? DEFAULT_PATHEXT) : '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));

  if (isAbsoluteProgramPath(entry)) {
    // A POSIX path means nothing on Windows (it is drive-relative there), and
    // a drive path means nothing on POSIX.
    if (!p.isAbsolute(entry) || (platform === 'win32') !== /^[A-Za-z]:\\/.test(entry)) {
      return null;
    }
    return (await isRunnable(entry, exts, dorkHomeReal, platform)) ? entry : null;
  }

  const rawPath = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const folders = [
    ...new Set(rawPath.split(p.delimiter).filter((folder) => folder && p.isAbsolute(folder))),
  ];
  const names =
    platform === 'win32' && !exts.includes(p.extname(entry).toLowerCase())
      ? exts.map((ext) => `${entry}${ext}`)
      : [entry];
  for (const folder of folders) {
    for (const name of names) {
      const candidate = p.join(folder, name);
      if (await isRunnable(candidate, exts, dorkHomeReal, platform)) return candidate;
    }
  }
  return null;
}
