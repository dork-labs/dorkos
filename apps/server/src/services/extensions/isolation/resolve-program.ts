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
 * - **Windows scripts.** `.cmd` and `.bat` files are run by `cmd.exe`, and
 *   Node refuses to start them without a shell, so the broker could never
 *   keep that promise. They are reported, not resolved.
 *
 * ## Programs the extension ships or can change are refused
 *
 * Deliberately, for now: a file whose real path is inside an extension's own
 * folder, its package (plugin or project root), the folder it runs from (a
 * snapshot or a dev link), any extension install root, or any extension data
 * folder resolves to nothing. An approval binds `allow.run` by name, not by
 * content, so a same-source update could swap such a file for anything
 * without a new card, and an isolated extension can write its own data
 * folder. This may be relaxed once an approval can bind a program's content.
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
import {
  isAbsoluteProgramPath,
  runEntryProblem,
  RUN_PROGRAM_NOT_FOUND,
} from '@dorkos/extension-api';

/** `PATHEXT` when the environment does not set one, as Windows ships it. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Windows script extensions Node will not start without a shell. */
const WINDOWS_SCRIPTS = new Set(['.cmd', '.bat']);

/** The folders under DorkOS's data directory that hold extension files. */
const DORK_HOME_EXTENSION_ROOTS = [
  'extensions',
  'plugins',
  'extension-data',
  'extension-snapshots',
  path.join('cache', 'extensions'),
];

/** The folders under a `.dork` folder that hold extension files. */
const DOT_DORK_EXTENSION_ROOTS = new Set(['extensions', 'plugins', 'extension-data']);

/** Why a program was not found. Shown on the record; the app compares it, so it lives in the API package. */
export const PROGRAM_NOT_FOUND = RUN_PROGRAM_NOT_FOUND;

/** Why a program the extension ships or can change was refused. Shown on the record. */
export const PROGRAM_INSIDE_EXTENSION =
  'It sits in extension files, which could change without asking.';

/** Why a Windows script was refused. Shown on the record. */
export const PROGRAM_IS_WINDOWS_SCRIPT =
  'Windows scripts (.cmd, .bat) need a shell, so they can’t run.';

/** What {@link resolveProgram} needs to know about the computer. */
export interface ResolveProgramOptions {
  /** DorkOS's data directory: its extension folders are refused. */
  dorkHome: string;
  /**
   * More folders whose contents are refused: the extension's own folder, its
   * package, and the folder it runs from (real or as named).
   */
  refusedRoots?: readonly string[];
  /** The environment whose `PATH` (and `PATHEXT`) is searched. Defaults to the server's. */
  env?: NodeJS.ProcessEnv;
  /** The platform the rules follow. Defaults to the server's. */
  platform?: NodeJS.Platform;
}

/** The program an entry names, or why there is none. */
export type ResolvedProgram = { path: string } | { path: null; reason: string };

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
 * Whether `child` is `root` or inside it.
 *
 * @param root - A folder.
 * @param child - A path.
 * @param p - The platform's path module.
 */
function isWithin(root: string, child: string, p: typeof path.posix): boolean {
  const rel = p.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * Whether a resolved file sits in extension files: DorkOS's extension
 * folders, any `.dork/extensions|plugins|extension-data`, or a refused root.
 *
 * @param real - The file's real path.
 * @param roots - Real paths of every refused folder.
 * @param p - The platform's path module.
 */
function isExtensionFile(real: string, roots: readonly string[], p: typeof path.posix): boolean {
  if (roots.some((root) => isWithin(root, real, p))) return true;
  const segments = real.split(/[\\/]+/);
  return segments.some(
    (segment, i) => segment === '.dork' && DOT_DORK_EXTENSION_ROOTS.has(segments[i + 1] ?? '')
  );
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
 * Judge one candidate file: runnable, a Windows script, inside extension
 * files, or not a program at all.
 *
 * @param candidate - An absolute path.
 * @param exts - Lowercase `PATHEXT` extensions (Windows).
 * @param roots - Real paths of every refused folder.
 * @param platform - The platform.
 */
async function judge(
  candidate: string,
  exts: readonly string[],
  roots: readonly string[],
  platform: NodeJS.Platform
): Promise<'runnable' | 'missing' | { refused: string }> {
  const p = pathFor(platform);
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return 'missing';
    if (platform === 'win32') {
      if (!exts.includes(p.extname(candidate).toLowerCase())) return 'missing';
    } else {
      await fs.access(candidate, fsConstants.X_OK);
    }
  } catch {
    return 'missing';
  }
  const real = await realOf(candidate);
  if (!real) return 'missing';
  // Both spellings: the real file (a link out to extension files) and the
  // path as named (a link from extension files, such as a dev link's slot).
  if (isExtensionFile(real, roots, p) || isExtensionFile(p.resolve(candidate), roots, p)) {
    return { refused: PROGRAM_INSIDE_EXTENSION };
  }
  if (platform === 'win32' && WINDOWS_SCRIPTS.has(p.extname(candidate).toLowerCase())) {
    return { refused: PROGRAM_IS_WINDOWS_SCRIPT };
  }
  return 'runnable';
}

/**
 * Find the program one `allow.run` entry names on this computer.
 *
 * @param entry - The entry as the manifest wrote it.
 * @param options - DorkOS's data directory and the extension's own folders,
 *   and optionally the environment and platform to follow.
 * @returns The absolute path of the program, or `null` with a plain reason:
 *   not found here, a Windows script, or a file in extension files.
 */
export async function resolveProgram(
  entry: string,
  options: ResolveProgramOptions
): Promise<ResolvedProgram> {
  const platform = options.platform ?? process.platform;
  // eslint-disable-next-line no-restricted-syntax -- PATH and PATHEXT are the live lookup environment, not app config
  const env = options.env ?? process.env;
  const p = pathFor(platform);
  if (runEntryProblem(entry)) return { path: null, reason: PROGRAM_NOT_FOUND };
  const dorkHomeReal = (await realOf(options.dorkHome)) ?? p.resolve(options.dorkHome);
  const rootCandidates = [
    ...DORK_HOME_EXTENSION_ROOTS.map((dir) => p.join(dorkHomeReal, dir)),
    ...(options.refusedRoots ?? []),
  ];
  const roots = [
    ...new Set(
      (
        await Promise.all(
          rootCandidates.map(async (root) => [p.resolve(root), (await realOf(root)) ?? null])
        )
      )
        .flat()
        .filter((root): root is string => !!root)
    ),
  ];
  const exts = (platform === 'win32' ? (env.PATHEXT ?? env.Pathext ?? DEFAULT_PATHEXT) : '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));

  if (isAbsoluteProgramPath(entry)) {
    // A POSIX path means nothing on Windows (it is drive-relative there), and
    // a drive path means nothing on POSIX.
    if (!p.isAbsolute(entry) || (platform === 'win32') !== /^[A-Za-z]:\\/.test(entry)) {
      return { path: null, reason: PROGRAM_NOT_FOUND };
    }
    const verdict = await judge(entry, exts, roots, platform);
    if (verdict === 'runnable') return { path: entry };
    return { path: null, reason: verdict === 'missing' ? PROGRAM_NOT_FOUND : verdict.refused };
  }

  const rawPath = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const folders = [
    ...new Set(rawPath.split(p.delimiter).filter((folder) => folder && p.isAbsolute(folder))),
  ];
  const names =
    platform === 'win32' && !exts.includes(p.extname(entry).toLowerCase())
      ? exts.map((ext) => `${entry}${ext}`)
      : [entry];
  // The first file found decides, as it would for a shell: a refused one is
  // reported, never skipped in favour of a later folder the card didn't name.
  for (const folder of folders) {
    for (const name of names) {
      const verdict = await judge(p.join(folder, name), exts, roots, platform);
      if (verdict === 'runnable') return { path: p.join(folder, name) };
      if (verdict !== 'missing') return { path: null, reason: verdict.refused };
    }
  }
  return { path: null, reason: PROGRAM_NOT_FOUND };
}
