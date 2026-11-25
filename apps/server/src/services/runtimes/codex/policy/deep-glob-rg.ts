/**
 * How the macOS profile finds the files its deep deny globs match (DOR-4358):
 * Codex's own vendored `rg`, run with no shell and fixed flags, and a
 * recursive folder watch that keeps a background base's last result current
 * between its scans. The base and globs come from DorkOS's own protected list,
 * never from anything an agent sends.
 *
 * `rg` never follows a symlink (no `-L`), and its `--null` output is split on
 * NUL, so a newline in a name can't split one path into two.
 *
 * @module services/runtimes/codex/policy/deep-glob-rg
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { codexVendoredRg } from './hidden-folder-scans.js';
import { trackedUnchangedNpmrc } from './tracked-npmrc.js';

/** What a folder watch reports. */
export interface DeepGlobWatchListener {
  /**
   * Something under the base changed.
   *
   * @param name - The changed path relative to the base, or `null` when the
   *   watch could not say which (the base's result can't be vouched for).
   */
  change(name: string | null): void;
  /** The watch stopped working; the base's result can't be vouched for. */
  fail(): void;
}

/** How the macOS profile finds files; tests pass their own. */
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
  /**
   * Watch everything under `base`, so a file that appears between two
   * background scans is named at the next render. `null` when no watch could
   * start; the base then keeps its globs.
   *
   * @param base - An existing folder.
   * @param listener - What to tell about each change.
   */
  watch(base: string, listener: DeepGlobWatchListener): { close(): void } | null;
}

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
/** An `rg` error line for a folder the server itself may not read. */
const UNREADABLE_LINE = /: (Permission denied|Operation not permitted) \(os error (1|13)\)$/;
/**
 * An `rg` permission error (EACCES) on a path, captured. Its own mode bits can
 * shut the server out of a folder the person owns, and the agent runs as that
 * person and can `chmod` it back open (Security's Must 2 on #3751).
 */
const MODE_BITS_LINE = /^rg: (.*): Permission denied \(os error 13\)$/;

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

/** The production scanner: Codex's vendored `rg`, and a recursive folder watch. */
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
  watch(base, listener) {
    try {
      // FSEvents on macOS: one stream for the whole tree, file-level changes.
      // `persistent: false`, so a watch never holds the server, or a test run, open.
      const watcher = fs.watch(base, { recursive: true, persistent: false }, (_event, name) =>
        listener.change(typeof name === 'string' ? name : null)
      );
      watcher.on('error', () => listener.fail());
      return watcher;
    } catch {
      return null;
    }
  },
};
