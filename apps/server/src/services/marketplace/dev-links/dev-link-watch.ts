/**
 * The file watch the dev link watcher opens on each linked folder (DOR-2696):
 * the seam a test replaces, and its default, chokidar.
 *
 * @module services/marketplace/dev-links/dev-link-watch
 */
import chokidar from 'chokidar';
import type { DevLinkChangeKind } from './dev-link-changes.js';

/** How long a file must stop changing before chokidar reports it (`skills-watcher.ts`). */
const WRITE_STABILITY_MS = 50;

/** @see {@link WRITE_STABILITY_MS} */
const WRITE_POLL_MS = 25;

/** Callbacks a {@link DevLinkWatchFactory} reports through. */
export interface DevLinkWatchListeners {
  /** A filesystem event at an absolute path. */
  onEvent(kind: DevLinkChangeKind, absPath: string): void;
  /** The first scan finished. */
  onReady(): void;
  /** The watch failed. */
  onError(err: unknown): void;
}

/**
 * Open a watch on a folder. The default is chokidar; a test passes a fake.
 *
 * @param folder - The folder's real path.
 * @param ignored - Whether an absolute path inside it is never watched, given
 *   whether it is known to be a directory.
 * @param listeners - Where to report.
 */
export type DevLinkWatchFactory = (
  folder: string,
  ignored: (absPath: string, isDirectory?: boolean) => boolean,
  listeners: DevLinkWatchListeners
) => { close(): Promise<void> };

/**
 * The default watch: chokidar over the whole folder, links not followed.
 *
 * @internal Exported so a test can wrap the real watch and see it close.
 */
export const chokidarDevLinkWatch: DevLinkWatchFactory = (folder, ignored, listeners) => {
  const watcher = chokidar.watch(folder, {
    persistent: true,
    ignoreInitial: true,
    // A link inside the working folder is not followed: it could lead out of
    // the folder, or back into it.
    followSymlinks: false,
    ignored: (absPath: string, stats?: { isDirectory(): boolean }) =>
      ignored(absPath, stats?.isDirectory()),
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
  });
  watcher.on('all', (eventName, absPath) => {
    if (
      eventName === 'add' ||
      eventName === 'addDir' ||
      eventName === 'change' ||
      eventName === 'unlink' ||
      eventName === 'unlinkDir'
    ) {
      listeners.onEvent(eventName, absPath);
    }
  });
  watcher.on('ready', () => listeners.onReady());
  watcher.on('error', (err) => listeners.onError(err));
  return { close: () => watcher.close() };
};
