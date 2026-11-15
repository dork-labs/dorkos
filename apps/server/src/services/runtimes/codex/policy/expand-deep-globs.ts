/**
 * On macOS, turn each deep deny glob (a base folder, then `**`, then a name)
 * into exact denies for the files that match (DOR-4358).
 *
 * Codex 0.163's Seatbelt profile adds, for every deny key with a wildcard,
 * `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex …)))`
 * over the folders that could hold a match. With `**` that is every folder
 * under the base: no folder under the agent's folder or the home folder can be
 * removed or renamed, so `rm -rf`, `npm ci` and a test fixture's teardown all
 * fail with EPERM while removing files still works. An exact deny gets the
 * same guard on its own parent folders only (verified on the binary: moving
 * the parent or a grandparent, renaming the file and hard-linking it are all
 * refused), so every other folder stays free.
 *
 * Security's choice (DOR-4358, A1): the folders the agent works in are scanned
 * on every render (a repo takes well under a second); every other base (the
 * home, data and account folders) is scanned in the background at most every
 * {@link BACKGROUND_SCAN_EVERY_MS}, and its last finished result is used. The
 * profile renders on every turn, and a whole-home scan can take ~20 s.
 *
 * Fail closed, always: a base keeps its `**` keys when it can't be read, when
 * its scan errors, times out or hasn't finished, when it holds a folder the
 * person owns but has shut by its mode bits (the agent could open it again with
 * `chmod`), when its last result skipped a folder this render does not deny
 * whole, when its last result is older
 * than {@link BACKGROUND_RESULT_MAX_AGE_MS}, or when its exact rules would pass
 * {@link MAX_EXACT_RULES} (Codex passes the profile on one command line, and
 * ~1,800 rules overflow it). Keeping them protects the secrets and only brings
 * the folder lock back for that base.
 *
 * What is never scanned: symlinks (`rg` doesn't follow them), `node_modules`
 * (public package files, which often ship test `*.pem` keys or an `.npmrc`),
 * git's content-addressed objects (whose hex names can match no protected
 * name) and folders the profile already denies whole. A git-tracked,
 * unmodified `.npmrc` stays readable; the home folder's own `~/.npmrc` is an
 * exact deny that never passes here.
 *
 * @module services/runtimes/codex/policy/expand-deep-globs
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { codexVendoredRg } from './hidden-folder-scans.js';
import {
  resetTrackedLookups,
  settleTrackedLookups,
  trackedUnchangedNpmrc,
} from './tracked-npmrc.js';

type Access = 'read' | 'deny';

/** The most exact rules one profile may gain; past this a base keeps its globs. */
export const MAX_EXACT_RULES = 400;
/** How often, at most, a background base is scanned again. */
export const BACKGROUND_SCAN_EVERY_MS = 5 * 60_000;
/** A background result older than this is not used; the base keeps its globs. */
export const BACKGROUND_RESULT_MAX_AGE_MS = 15 * 60_000;

/** Where a deep glob splits into its base folder and the name it matches. */
const DEEP = '/**/';
/** A deep folder rule's companion key, which covers the folder's contents. */
const CONTENTS = '/**';
/** Characters that make a profile key a glob rather than a literal path. */
const GLOB = /[*?[\]{}]/;
/** How long a working folder's scan may take; it runs on the turn's path. */
const WORKING_SCAN_TIMEOUT_MS = 5_000;
/** How long a background scan may take before its base keeps its globs. */
const BACKGROUND_SCAN_TIMEOUT_MS = 180_000;
/**
 * Threads a background scan may use. Nothing waits on it, and an unbounded
 * `rg` takes every core of a machine that is already running agents.
 */
const BACKGROUND_SCAN_THREADS = 2;
/** The most scan output read; a base with more keeps its globs. */
const SCAN_MAX_BUFFER = 16 << 20;
/** The project file whose tracked copy stays readable (Security, DOR-4358). */
const TRACKED_READABLE_NAME = '.npmrc';
/**
 * Folders never scanned, at any depth: `node_modules` holds public package
 * files, and git's objects are named by hash, so no protected name matches.
 */
const NEVER_SCANNED = ['node_modules', '.git/objects'];
/** An `rg` error line for a folder the server itself may not read. */
const UNREADABLE_LINE = /: (Permission denied|Operation not permitted) \(os error (1|13)\)$/;
/**
 * An `rg` permission error (EACCES) on a path, captured. Its own mode bits can
 * shut the server out of a folder the person owns, and the agent runs as that
 * person and can `chmod` it back open (Security's Must 2 on #3751).
 */
const MODE_BITS_LINE = /^rg: (.*): Permission denied \(os error 13\)$/;

/** How {@link expandDeepGlobs} finds files; tests pass their own. */
export interface DeepGlobScanner {
  /**
   * Every file under `base` matching one of `globs`, as absolute paths, or
   * `null` when the scan could not finish. Runs on the turn's path.
   *
   * @param base - An existing folder.
   * @param globs - `rg` globs relative to `base`, `!`-prefixed ones excluding.
   */
  files(base: string, globs: readonly string[]): string[] | null;
  /**
   * The same scan, off the turn's path.
   *
   * @param base - An existing folder.
   * @param globs - `rg` globs relative to `base`, `!`-prefixed ones excluding.
   */
  filesLater(base: string, globs: readonly string[]): Promise<string[] | null>;
  /**
   * The `.npmrc` files git tracks under `base` whose bytes match the tracked
   * copy, as absolute paths. Empty when `base` is not in a repository. The
   * production scanner reads only git's index, off the turn's path, and checks
   * the bytes at render time (`tracked-npmrc.ts`); a render before the first
   * index read denies every `.npmrc`.
   *
   * @param base - An existing folder.
   */
  trackedNpmrc(base: string): ReadonlySet<string>;
}

/** What {@link expandDeepGlobs} needs beyond the entries. */
export interface ExpandDeepGlobsOptions {
  /** The platform the profile is rendered for; only `darwin` expands. */
  platform: NodeJS.Platform;
  /** Folders the agent works in: a base inside one is scanned on every render. */
  working: readonly string[];
  /** How to scan; the vendored `rg` by default. */
  scanner?: DeepGlobScanner;
  /** The clock; tests pass their own. */
  now?: () => number;
}

/** One name a base's deep keys match, as a file or as a folder and its contents. */
interface DeepPattern {
  readonly tail: string;
  readonly folder: boolean;
  readonly keys: string[];
}

/** One background base's scans: the last finished result and the one in flight. */
interface BackgroundScan {
  files?: string[];
  /** The folders the finished scan skipped (its `!` globs). */
  skipped?: readonly string[];
  finishedAt?: number;
  startedAt?: number;
  running?: Promise<void>;
}

const background = new Map<string, BackgroundScan>();

/** A tail's name as a regex body: `*` matches within one path segment. */
function tailSource(tail: string): string {
  return tail
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
}

/**
 * Where `relative` matches the pattern: the file itself, or for a folder
 * pattern the matching folder above it. `undefined` when it doesn't match.
 */
function matchOf(pattern: DeepPattern, relative: string): string | undefined {
  const body = tailSource(pattern.tail);
  if (!pattern.folder) return new RegExp(`(^|/)${body}$`).test(relative) ? relative : undefined;
  const found = new RegExp(`^((?:.*/)?${body})/`).exec(relative);
  return found?.[1];
}

/** Whether `dir` is a real folder this process can see. */
function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `dir` is `root` or inside it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}/`);
}

/** Group the deep deny keys by base folder, merging a folder rule with its contents key. */
function deepPatternsByBase(entries: Readonly<Record<string, Access>>) {
  const byBase = new Map<string, Map<string, DeepPattern>>();
  for (const key of Object.keys(entries)) {
    const at = key.indexOf(DEEP);
    if (at <= 0 || entries[key] !== 'deny') continue;
    const base = key.slice(0, at);
    if (GLOB.test(base)) continue;
    let tail = key.slice(at + DEEP.length);
    const contents = tail.endsWith(CONTENTS);
    if (contents) tail = tail.slice(0, -CONTENTS.length);
    if (tail.length === 0 || tail.includes('**')) continue;
    const patterns = byBase.get(base) ?? new Map<string, DeepPattern>();
    const existing = patterns.get(tail);
    const folder = contents || existing?.folder === true || `${key}${CONTENTS}` in entries;
    patterns.set(tail, { tail, folder, keys: [...(existing?.keys ?? []), key] });
    byBase.set(base, patterns);
  }
  return byBase;
}

/** The `rg` globs for a base: every pattern, then everything never scanned. */
function globsFor(
  base: string,
  patterns: readonly DeepPattern[],
  entries: Readonly<Record<string, Access>>
): string[] {
  const include = patterns.map((p) => (p.folder ? `**/${p.tail}/**` : `**/${p.tail}`));
  // A folder the profile already denies whole needs no scan: its files are covered.
  const deniedWhole = Object.keys(entries)
    .filter((key) => entries[key] === 'deny' && !GLOB.test(key) && key.startsWith(`${base}/`))
    .map((key) => `!${key.slice(base.length + 1)}/**`);
  return [...include, ...NEVER_SCANNED.map((dir) => `!**/${dir}/**`), ...deniedWhole];
}

/**
 * A background base's last usable result, starting a fresh scan when the last
 * one began at least {@link BACKGROUND_SCAN_EVERY_MS} ago. `null` until a scan
 * has finished, and once the last finished one is too old.
 */
function backgroundFiles(
  base: string,
  globs: readonly string[],
  scanner: DeepGlobScanner,
  now: () => number
): string[] | null {
  // Keyed by what is searched for, not by the skipped folders: those change
  // whenever a denied folder appears, and a new key would mean a new scan and a
  // thread reload each time.
  const key = `${base}\0${globs.filter((glob) => !glob.startsWith('!')).join('\0')}`;
  const skipping = globs.filter((glob) => glob.startsWith('!'));
  const scan = background.get(key) ?? {};
  background.set(key, scan);
  // A result that skipped a folder this render no longer denies whole never
  // looked inside it, so it can't vouch for that folder: scan again now.
  const covers = (scan.skipped ?? []).every((glob) => skipping.includes(glob));
  const due =
    !covers || scan.startedAt === undefined || now() - scan.startedAt >= BACKGROUND_SCAN_EVERY_MS;
  if (scan.running === undefined && due) {
    scan.startedAt = now();
    scan.running = scanner
      .filesLater(base, globs)
      .then((files) => {
        if (files === null) return;
        scan.files = files;
        scan.skipped = skipping;
        scan.finishedAt = now();
      })
      .catch(() => undefined)
      .finally(() => {
        scan.running = undefined;
      });
  }
  const fresh =
    scan.finishedAt !== undefined && now() - scan.finishedAt <= BACKGROUND_RESULT_MAX_AGE_MS;
  return fresh && covers && scan.files !== undefined ? scan.files : null;
}

/**
 * The exact keys a base's matching files become.
 *
 * @param base - The scanned base folder.
 * @param files - The base's matching files.
 * @param patterns - What the base's deep keys match.
 * @param tracked - Tracked, unchanged `.npmrc` files to leave readable.
 */
function exactKeys(
  base: string,
  files: readonly string[],
  patterns: readonly DeepPattern[],
  tracked: ReadonlySet<string>
): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const relative = path.relative(base, file).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    for (const pattern of patterns) {
      const match = matchOf(pattern, relative);
      if (match === undefined) continue;
      const literal = `${base}/${match}`;
      if (pattern.tail === TRACKED_READABLE_NAME && tracked.has(literal)) continue;
      keys.add(literal);
    }
  }
  return keys;
}

/**
 * Replace each deep deny glob with exact denies for the files it matches.
 * Only on macOS; every other platform keeps the profile as it is.
 *
 * @param entries - The rendered profile filesystem entries.
 * @param options - The platform, the working folders, and how to scan.
 */
export function expandDeepGlobs(
  entries: Readonly<Record<string, Access>>,
  options: ExpandDeepGlobsOptions
): Record<string, Access> {
  const result: Record<string, Access> = { ...entries };
  if (options.platform !== 'darwin') return result;
  const scanner = options.scanner ?? ripgrepScanner;
  const now = options.now ?? Date.now;
  let budget = MAX_EXACT_RULES;
  for (const [base, byTail] of deepPatternsByBase(entries)) {
    if (!isFolder(base)) continue;
    const patterns = [...byTail.values()];
    const globs = globsFor(base, patterns, entries);
    const working = options.working.some((folder) => within(base, folder));
    const files = working ? scanner.files(base, globs) : backgroundFiles(base, globs, scanner, now);
    if (files === null) continue;
    const tracked =
      working && patterns.some((p) => p.tail === TRACKED_READABLE_NAME)
        ? scanner.trackedNpmrc(base)
        : new Set<string>();
    const keys = exactKeys(base, files, patterns, tracked);
    if (keys.size > budget) continue;
    budget -= keys.size;
    for (const pattern of patterns) for (const key of pattern.keys) delete result[key];
    for (const key of keys) result[key] = 'deny';
  }
  return result;
}

/**
 * Wait for the background scans and tracked-file lookups in flight, of one
 * base or of all.
 *
 * @param base - Only this base's; omitted, every one.
 * @internal Exported for tests.
 */
export async function settleBackgroundScans(base?: string): Promise<void> {
  const prefix = base === undefined ? undefined : `${base}\0`;
  await Promise.all([
    ...[...background.entries()]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .map(([, scan]) => scan.running),
    settleTrackedLookups(base),
  ]);
}

/**
 * Forget every background result and tracked-file answer, so each test starts cold.
 *
 * @internal Exported for tests.
 */
export function resetBackgroundScans(): void {
  background.clear();
  resetTrackedLookups();
}

/**
 * The `rg` arguments for one scan. It never follows a symlink (no `-L`).
 *
 * @param base - The folder scanned.
 * @param globs - What to find and what to skip.
 * @param threads - A thread cap, for a scan nothing waits on.
 */
function rgArgs(base: string, globs: readonly string[], threads?: number): string[] {
  const args = ['--no-config', '--files', '--hidden', '--no-ignore', '--null'];
  if (threads !== undefined) args.push('--threads', String(threads));
  for (const glob of globs) args.push('--glob', glob);
  return [...args, '--', base];
}

/**
 * Whether the person owns a path the server was refused by mode bits. Anything
 * that can't be told counts as owned, so its base keeps its globs.
 *
 * @param file - The path `rg` named.
 */
function ownedPath(file: string): boolean {
  try {
    return fs.lstatSync(file).uid === process.getuid?.();
  } catch {
    return true;
  }
}

/**
 * What a finished `rg` run means: its output, or `null` when the scan did not
 * finish. Exit 1 with no errors is "no matches". Exit 2 with only unreadable
 * folders is a finished scan when the agent can't open them either: a privacy
 * block or another owner (EPERM, or EACCES on a path someone else owns). A
 * folder the person owns but has shut by its mode bits is not: the agent can
 * `chmod` it, so its base keeps its globs.
 *
 * @param base - The folder scanned; `rg`'s relative paths resolve against it.
 * @param error - What the failed run reported, or `null` on success.
 * @param stdout - What it printed.
 */
function rgOutcome(
  base: string,
  error: { status?: number | null; code?: unknown; stderr?: string } | null,
  stdout: string
): string | null {
  if (error === null) return stdout;
  const status = typeof error.status === 'number' ? error.status : error.code;
  const stderr = (error.stderr ?? '').split('\n').filter(Boolean);
  if (status === 1 && stderr.length === 0) return '';
  if (status !== 2 || stderr.length === 0) return null;
  if (!stderr.every((line) => UNREADABLE_LINE.test(line))) return null;
  const ownShut = stderr.some((line) => {
    const named = MODE_BITS_LINE.exec(line)?.[1];
    return named !== undefined && ownedPath(path.resolve(base, named));
  });
  return ownShut ? null : stdout;
}

/** `rg --null` output as absolute paths: split on NUL, so a newline in a name can't. */
function outputFiles(base: string, out: string): string[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => (path.isAbsolute(line) ? line : path.join(base, line)));
}

/**
 * The production scanner: Codex's own vendored `rg`, run with no shell and
 * fixed flags. The base and globs come from DorkOS's own protected list, never
 * from anything an agent sends.
 */
export const ripgrepScanner: DeepGlobScanner = {
  files(base, globs) {
    const rg = codexVendoredRg();
    if (!rg) return null;
    try {
      const out = execFileSync(rg, rgArgs(base, globs), {
        cwd: base,
        encoding: 'utf8',
        timeout: WORKING_SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER,
        env: runtimeEnvironment('codex', 'process-inspection'),
      });
      return outputFiles(base, out);
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      const out = rgOutcome(base, failure, failure.stdout ?? '');
      return out === null ? null : outputFiles(base, out);
    }
  },
  filesLater(base, globs) {
    const rg = codexVendoredRg();
    if (!rg) return Promise.resolve(null);
    return new Promise((resolve) => {
      const child = execFile(
        rg,
        rgArgs(base, globs, BACKGROUND_SCAN_THREADS),
        {
          cwd: base,
          encoding: 'utf8',
          timeout: BACKGROUND_SCAN_TIMEOUT_MS,
          maxBuffer: SCAN_MAX_BUFFER,
          env: runtimeEnvironment('codex', 'process-inspection'),
        },
        (error, stdout, stderr) => {
          const out = rgOutcome(base, error === null ? null : { ...error, stderr }, stdout);
          resolve(out === null ? null : outputFiles(base, out));
        }
      );
      // A scan in flight never holds the server, or a test run, open.
      child.unref();
    });
  },
  trackedNpmrc: trackedUnchangedNpmrc,
};
