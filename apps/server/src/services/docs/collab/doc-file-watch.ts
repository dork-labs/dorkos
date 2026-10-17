/**
 * Watch one open doc's file for changes DorkOS did not make (DOR-2984).
 *
 * Native file events first; if the watcher fails (too many watched files,
 * a filesystem that does not report events), it falls back to polling, so a
 * change made by an agent's own Write tool is never missed while the doc is
 * open.
 *
 * It watches the file's FOLDER, one level deep, and listens for this one file:
 * watching the file itself misses its deletion (chokidar 5 on `fs.watch`
 * reports nothing once the watched inode is gone), and a deleted or renamed
 * doc is exactly what an editor must be told about.
 *
 * @module services/docs/collab/doc-file-watch
 */
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../../../lib/logger.js';

/** What happened to the file. */
export type DocFileEvent = 'changed' | 'removed';

/** How often the polling fallback looks at the file. */
const POLL_INTERVAL_MS = 1_000;

/** How long opening a doc waits for its watcher to be ready. */
const READY_WAIT_MS = 2_000;

/** A running watch; close it when the doc closes. */
export interface DocFileWatch {
  /**
   * Resolves once the watcher reports events (or after a short wait, so a slow
   * watcher never keeps a doc from opening). A change before this is not
   * reported: the caller checks the file once after it.
   */
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * Start watching `file`.
 *
 * @param file - The doc's file.
 * @param onEvent - Called on each change or removal.
 */
export function watchDocFile(file: string, onEvent: (event: DocFileEvent) => void): DocFileWatch {
  let watcher: FSWatcher;
  let closed = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const readyTimer = setTimeout(() => markReady(), READY_WAIT_MS);
  readyTimer.unref?.();
  const dir = path.dirname(file);
  const start = (usePolling: boolean): FSWatcher => {
    const next = chokidar.watch(dir, {
      depth: 0,
      // Only the folder itself (to be watched at all) and this one file.
      ignored: (candidate: string) => candidate !== dir && candidate !== file,
      ignoreInitial: true,
      usePolling,
      interval: POLL_INTERVAL_MS,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });
    next.on('change', (changed) => changed === file && onEvent('changed'));
    next.on('add', (added) => added === file && onEvent('changed'));
    next.on('unlink', (removed) => removed === file && onEvent('removed'));
    next.on('ready', () => markReady());
    next.on('error', (err) => {
      if (closed || usePolling) {
        logger.warn('[docs] the doc file watcher failed', { err });
        return;
      }
      logger.warn('[docs] the doc file watcher failed; watching by polling instead', { err });
      const failed = watcher;
      watcher = start(true);
      void failed.close().catch(() => undefined);
    });
    return next;
  };
  watcher = start(false);
  return {
    ready,
    close: async () => {
      closed = true;
      clearTimeout(readyTimer);
      markReady();
      await watcher.close();
    },
  };
}
