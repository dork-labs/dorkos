/**
 * Running one git command for the marketplace, with limits (DOR-2321).
 *
 * Git runs a package author's server's answers, so every command here is
 * bounded: by time, by how much it prints, and, for a download, by how much
 * it writes to disk. A command that passes a limit is stopped with its whole
 * process tree, because killing git alone leaves its helpers (`index-pack`,
 * `upload-pack`, a transport) running and writing: git starts in its own
 * process group on POSIX and the group is killed, and on Windows
 * `taskkill /T` walks the tree.
 *
 * Starting git in its own group also means the terminal's Ctrl-C no longer
 * reaches it, so every running group is tracked and stopped when this process
 * exits or is sent SIGINT or SIGTERM.
 *
 * @module services/marketplace/lib/git-runner
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { withGitConfigEnv, type GitConfigEntry } from '@dorkos/shared/git-hardening';
import { hardenedGitEnv, internalGitArgs } from '../../../../lib/git-safety.js';

/** One `git -c`-style setting, passed through the environment instead of argv. */
export type { GitConfigEntry };

/** A byte count in plain words: GB from one gigabyte up, else MB. */
function describeDownloadBytes(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  return bytes >= gb ? `${Math.round(bytes / gb)} GB` : `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/**
 * A git download that passed the clone limits (DOR-2321): it grew past the
 * byte limit while downloading, or its tree lists more files and folders, or
 * more bytes, than DorkOS unpacks. Raised before anything is checked out.
 */
export class GitDownloadTooLargeError extends Error {
  /**
   * Build the error for one limit.
   *
   * @param kind - `growing` while downloading, else what the tree listing found.
   * @param limit - The limit passed: bytes, or files and folders for `entries`.
   */
  constructor(kind: 'growing' | 'bytes' | 'entries', limit: number) {
    super(
      kind === 'growing'
        ? `The download grew past ${describeDownloadBytes(limit)}, so DorkOS stopped it.`
        : kind === 'bytes'
          ? `The download is larger than ${describeDownloadBytes(limit)}, so DorkOS did not unpack it.`
          : `The download has more than ${limit.toLocaleString('en-US')} files and folders, so DorkOS did not unpack it.`
    );
    this.name = 'GitDownloadTooLargeError';
  }
}

/** How one git command is watched while it runs. */
export interface GitRunOptions {
  /**
   * Stop git once the files under `dir` pass `maxBytes`, or the free space on
   * the disk holding `freeSpaceOf` drops by more than `maxBytes` (plus
   * {@link FREE_SPACE_MARGIN}) since git started, checked every
   * {@link WATCH_INTERVAL_MS}. The first catches a download; the second
   * catches anything git writes elsewhere, such as a checkout. Portable (no
   * `ulimit`), so it holds on Windows too.
   */
  watch?: { dir: string; freeSpaceOf: string; maxBytes: number };
  /**
   * Called for each line of output; returning `false` stops git. Output given
   * to it is not kept, so a long listing is limited by the caller's own
   * count rather than by the output limit.
   */
  onStdoutLine?: (line: string) => boolean;
  /** Text written to git's standard input. */
  stdin?: string;
  /** Extra environment variables for this one command. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The most output one git command may print and keep, per stream; more stops
 * it. Standard output holds `cat-file --batch-check` answers (about 60
 * characters per file, so 100,000 files fit many times over); standard error
 * holds only git's messages. An object so a test can shrink it.
 *
 * @internal
 */
export const GIT_OUTPUT_LIMITS = {
  stdoutChars: 16 * 1024 * 1024,
  stderrChars: 1024 * 1024,
};

/** How often a watched command's size on disk is checked. */
const WATCH_INTERVAL_MS = 200;

/**
 * Room for the disk's other writers before a free-space drop counts as git's.
 * The drop is measured for the whole disk, so two large installs running at
 * once could each see the other's writes; with a 1 GB limit and this margin
 * that needs two downloads near the limit at the same moment, which is
 * theoretical for a person's own machine. The watch on `.git` is exact.
 */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

/**
 * The total size of every file under `dir`, `0` when it does not exist yet.
 *
 * @param dir - The directory to measure.
 */
async function sizeOnDisk(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += (await lstat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/**
 * Free bytes on the disk holding `dir`, or `undefined` where that cannot be read.
 *
 * @param dir - Any path on the disk.
 */
async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Whether a watched git command has gone past its byte limit: the watched
 * directory holds more than `maxBytes`, or the disk has lost more than
 * `maxBytes` plus {@link FREE_SPACE_MARGIN} of free space since it started.
 *
 * @param sample - What one poll saw.
 * @returns `true` to stop git.
 * @internal Exported for tests.
 */
export function pastByteLimit(sample: {
  size: number;
  freeBefore: number | undefined;
  freeNow: number | undefined;
  maxBytes: number;
}): boolean {
  const { size, freeBefore, freeNow, maxBytes } = sample;
  const drop = freeBefore !== undefined && freeNow !== undefined ? freeBefore - freeNow : 0;
  return size > maxBytes || drop > maxBytes + FREE_SPACE_MARGIN;
}

/**
 * Stop a process and everything it started. On POSIX the process leads its
 * own group, and the group is killed; on Windows, `taskkill /T` walks the tree.
 *
 * @param pid - The process to stop, with its descendants.
 * @param platform - The platform to act for; a parameter so tests can check
 *   the Windows branch anywhere.
 * @param run - Runs `taskkill` on Windows; a parameter for the same reason.
 * @internal Exported for tests.
 */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => void = (file, args) => {
    execFile(file, args, { windowsHide: true }, () => {});
  }
): void {
  if (platform === 'win32') {
    run('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Not a group leader after all (or already gone): stop the process itself.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Every git process (group) this process has started and not yet seen end. */
const running = new Set<number>();
let exitHandlersInstalled = false;

/**
 * Stop every running git process tree. Synchronous, so it can run while this
 * process exits: on Windows `taskkill` runs to completion before returning.
 *
 * @param kill - Stops one tree; a parameter so tests can observe it.
 * @internal Exported for tests.
 */
export function stopAllGit(kill: (pid: number) => void = stopTreeNow): void {
  for (const pid of running) kill(pid);
  running.clear();
}

/** {@link killProcessTree}, synchronous on Windows too. */
function stopTreeNow(pid: number): void {
  killProcessTree(pid, process.platform, (file, args) => {
    spawnSync(file, args, { windowsHide: true });
  });
}

/**
 * Stop running git on the way out, then leave the signal's usual effect
 * alone: when no one else listens for it, this process still exits.
 *
 * @param signal - The signal received.
 */
function onSignal(signal: NodeJS.Signals): void {
  stopAllGit();
  if (process.listenerCount(signal) === 1) {
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  }
}

/**
 * Remember a started git group, installing the exit and signal handlers the
 * first time. Groups started detached miss the terminal's Ctrl-C, so these
 * handlers are what stops them when DorkOS stops.
 *
 * @param pid - The group leader.
 * @internal Exported for tests.
 */
export function trackGit(pid: number): void {
  running.add(pid);
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  process.on('exit', () => stopAllGit());
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * Forget a git group that has ended.
 *
 * @param pid - The group leader.
 */
function untrackGit(pid: number): void {
  running.delete(pid);
}

/**
 * Run one git command. `cwd` is the fetch directory, or `undefined` for
 * `ls-remote`, which needs no repository. A rejection carries git's `stdout`
 * and `stderr`, as `execFile`'s promise form does, and `killed: true` when
 * git ran out of time. Every way of stopping git (its time running out, a
 * size limit, an output limit) stops its whole process tree.
 *
 * @param args - Git's arguments.
 * @param cwd - Where git runs.
 * @param timeout - How long it may run, in milliseconds.
 * @param config - `git -c` settings passed through the environment.
 * @param options - Watching, streaming, input and extra environment.
 * @returns What git printed.
 */
export async function runGit(
  args: string[],
  cwd: string | undefined,
  timeout: number,
  config: GitConfigEntry[] = [],
  options: GitRunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let watchTimer: NodeJS.Timeout | undefined;
    let tooLarge = false;
    let stopped = false;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    // The hardening as `-c` too: the environment copy is read only by git 2.31
    // and later, and this repo supports 2.25 (DOR-2326).
    const child = spawn('git', [...internalGitArgs(), ...args], {
      cwd,
      // Confine git to safe transports so an author-controlled URL cannot reach
      // the `ext::`/`file::` helpers, and never prompt for a credential.
      env: { ...withGitConfigEnv(hardenedGitEnv(), config), ...options.env },
      windowsHide: true,
      // Its own process group on POSIX, so the whole tree can be stopped.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) trackGit(child.pid);
    const kill = (): void => {
      if (child.pid !== undefined) killProcessTree(child.pid);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const finish = (err: (Error & { code?: unknown }) | null): void => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) untrackGit(child.pid);
      if (watchTimer) clearInterval(watchTimer);
      clearTimeout(timeoutTimer);
      if (tooLarge) return reject(new GitDownloadTooLargeError('growing', options.watch!.maxBytes));
      if (stopped) return resolve({ stdout, stderr });
      if (timedOut) {
        return reject(Object.assign(new Error('git timed out'), { killed: true, stdout, stderr }));
      }
      if (overflowed) {
        return reject(Object.assign(new Error('git printed too much'), { stdout, stderr }));
      }
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    };
    const overflow = (): void => {
      if (overflowed) return;
      overflowed = true;
      kill();
    };
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > GIT_OUTPUT_LIMITS.stderrChars) overflow();
    });
    let partial = '';
    const onLine = options.onStdoutLine;
    child.stdout.on('data', (chunk: string) => {
      if (!onLine) {
        stdout += chunk;
        if (stdout.length > GIT_OUTPUT_LIMITS.stdoutChars) overflow();
        return;
      }
      if (stopped) return;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!onLine(line)) {
          stopped = true;
          kill();
          return;
        }
      }
    });
    child.stdout.on('end', () => {
      // A last line with no line break after it.
      if (onLine && !stopped && partial !== '' && !onLine(partial)) stopped = true;
    });
    child.stdin.on('error', () => {
      // Git may exit without reading its input; that is its answer, not ours.
    });
    child.stdin.end(options.stdin ?? '');
    child.once('error', (err) => finish(err));
    child.once('close', (code, signal) => {
      finish(
        code === 0 && signal === null
          ? null
          : Object.assign(new Error(`Command failed: git ${args.join(' ')}`), { code, signal })
      );
    });
    if (options.watch) {
      const { dir, freeSpaceOf, maxBytes } = options.watch;
      const startFree = freeBytes(freeSpaceOf);
      let busy = false;
      watchTimer = setInterval(() => {
        if (busy || tooLarge) return;
        busy = true;
        void Promise.all([sizeOnDisk(dir), startFree, freeBytes(freeSpaceOf)]).then(
          ([size, freeBefore, freeNow]) => {
            busy = false;
            if (pastByteLimit({ size, freeBefore, freeNow, maxBytes })) {
              tooLarge = true;
              kill();
            }
          }
        );
      }, WATCH_INTERVAL_MS);
    }
  });
}
