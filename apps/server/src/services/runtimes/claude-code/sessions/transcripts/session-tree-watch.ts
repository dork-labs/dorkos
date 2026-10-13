/**
 * How the session-list watcher hears about a projects root changing on disk.
 *
 * Two ways, chosen by platform. Both report the same three things: a
 * transcript (`{root}/{slug}/{id}.jsonl`) appeared, changed or went away; a slug
 * directory appeared or went away; or the watch failed.
 *
 * - **One recursive `fs.watch` per root** on macOS, where the operating system
 *   watches a whole tree natively (FSEvents) and holds no file descriptor per
 *   file. chokidar, which this replaced there,
 *   watched every transcript separately: on macOS that is a kqueue descriptor
 *   per file, and the affected machine held 758 of them open for its
 *   transcripts alone (DOR-2907), against a default soft limit of 256 per
 *   process for a desktop app.
 * - **chokidar** elsewhere, as before. On Linux its inotify watches are per
 *   directory anyway, and Windows has no comparable limit.
 *
 * Two things FSEvents does that chokidar did not, and what covers them: a
 * symlinked slug folder is not followed, and events can be dropped while
 * another watch in the process starts or stops (Node shares one FSEvents
 * stream). New and removed transcripts move a directory's mtime, which the
 * reconcile sweep reads every 5 s; an append to an existing one is caught by
 * the sweep's once-a-minute transcript check. And a newly created file keeps
 * reporting `rename` for its first few seconds, so its appends count as
 * urgent that long: bounded, and only for a new session.
 *
 * Neither is the source of truth; the watcher's reconcile sweep is (see
 * `session-list-watcher.ts`). A watch that never armed or died only costs
 * latency until the next sweep.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/session-tree-watch
 */
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { WATCHER } from '../../../../../config/constants.js';

/** What a tree watch reports. */
export interface TreeWatchEvents {
  /**
   * A transcript one level down changed. `urgent` when it appeared or went
   * away, rather than changed in place.
   */
  file(filePath: string, urgent: boolean): void;
  /** A slug directory, one level down, appeared or went away. */
  dir(dirPath: string): void;
  /** Something changed that the platform did not name; check everything. */
  unknown(): void;
  /** The watch failed. */
  error(err: unknown): void;
}

/** A running tree watch. */
export interface TreeWatch {
  /** Stop watching. */
  close(): Promise<void>;
}

/** Start watching one projects root. */
export type TreeWatcher = (root: string, on: TreeWatchEvents) => TreeWatch;

/** How long a native watch on a root that is not there yet waits before trying again. */
export const NATIVE_WATCH_RETRY_MS = 5_000;

/**
 * chokidar, at depth 1: the root's slug directories and the transcripts directly
 * inside them. NO glob: chokidar v4 dropped glob support, so a `{dir}/*.jsonl`
 * pattern watches a literal path that never exists.
 *
 * @param root - The projects root.
 * @param on - Where to report.
 */
export const chokidarTreeWatcher: TreeWatcher = (root, on) => {
  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true, // the session-list watcher scans for the initial inventory
    depth: 1,
    awaitWriteFinish: {
      stabilityThreshold: WATCHER.STABILITY_THRESHOLD_MS,
      pollInterval: WATCHER.POLL_INTERVAL_MS,
    },
  });
  watcher.on('add', (filePath: string) => on.file(filePath, true));
  watcher.on('change', (filePath: string) => on.file(filePath, false));
  watcher.on('unlink', (filePath: string) => on.file(filePath, true));
  watcher.on('addDir', (dirPath: string) => on.dir(dirPath));
  watcher.on('unlinkDir', (dirPath: string) => on.dir(dirPath));
  watcher.on('error', (err) => on.error(err));
  return { close: () => watcher.close() };
};

/**
 * One recursive `fs.watch` on the root. Events below the slug level (a
 * session's `subagents/` folder) arrive too, and are dropped here.
 *
 * `fs.watch` names what changed but not how: `rename` is an appearance or a
 * disappearance, and both are urgent to the list; `change` is an edit in place.
 * A root that does not exist yet (Claude Code never ran under this account) is
 * tried again every {@link NATIVE_WATCH_RETRY_MS}, and so is a watch that died.
 *
 * @param root - The projects root.
 * @param on - Where to report.
 * @param retryMs - The wait before trying to arm again. Tests shorten it.
 */
export function nativeTreeWatcher(
  root: string,
  on: TreeWatchEvents,
  retryMs: number = NATIVE_WATCH_RETRY_MS
): TreeWatch {
  let watcher: fs.FSWatcher | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closed = false;

  const scheduleRetry = (): void => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      arm();
    }, retryMs);
    retry.unref();
  };

  const arm = (): void => {
    if (closed) return;
    try {
      const rootName = path.basename(root);
      watcher = fs.watch(root, { recursive: true, persistent: true }, (eventType, filename) => {
        if (filename === null) return on.unknown();
        const relative = String(filename);
        // FSEvents names the root itself when it drops events or the root moves;
        // nothing under it can be trusted to have been reported.
        if (relative === rootName) return on.unknown();
        const parts = relative.split(/[\\/]/);
        if (parts.length === 1) {
          // A slug directory, or a stray file sitting in the root (not a session).
          if (!relative.endsWith('.jsonl')) on.dir(path.join(root, relative));
        } else if (parts.length === 2 && relative.endsWith('.jsonl')) {
          on.file(path.join(root, relative), eventType === 'rename');
        }
      });
      watcher.on('error', (err) => {
        on.error(err);
        watcher?.close();
        watcher = undefined;
        scheduleRetry();
      });
    } catch (err) {
      // A root that is not there yet is the normal first-run state, not a failure.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') on.error(err);
      scheduleRetry();
    }
  };

  arm();
  return {
    close: async () => {
      closed = true;
      if (retry) clearTimeout(retry);
      watcher?.close();
    },
  };
}

/**
 * The tree watch for this platform: native on macOS, where chokidar's
 * descriptor per transcript ran into the open-file limit; chokidar elsewhere.
 * Windows could watch natively too, but has no such limit and no server test
 * run, so it keeps the watch that has been running there.
 *
 * @param platform - `process.platform`, injectable for tests.
 */
export function defaultTreeWatcher(platform: NodeJS.Platform = process.platform): TreeWatcher {
  return platform === 'darwin' ? (root, on) => nativeTreeWatcher(root, on) : chokidarTreeWatcher;
}
