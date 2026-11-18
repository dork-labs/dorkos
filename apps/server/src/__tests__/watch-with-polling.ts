/**
 * Swap the OPERATING SYSTEM's file-change notifications for polling, in a test
 * that drives a real file watcher over a real folder.
 *
 * macOS drops filesystem events outright rather than late: measured on this
 * machine on 2026-09-12/13, 7 of 20 single writes under a native watch went
 * unreported at a load average of 78, and inside a Vitest worker as few as 2 of
 * 7 fresh watches saw their file. So "I wrote the file and nothing happened"
 * cannot tell a broken handler from a dropped event, and a case resting on it
 * reds on somebody else's branch (DOR-2012, DOR-2021). A `stat` on an interval
 * does not drop anything, so with these in place an event that did not arrive
 * did not happen.
 *
 * Everything else stays real: the folder on disk, the production watcher's own
 * options and wiring, and the handlers it runs. Only how a change is NOTICED
 * is substituted.
 *
 * The `fs.watch` twin has no library behind it, so two things are this file's
 * own rather than the platform's: which of `rename` and `change` a difference
 * is reported as, and what it never sends — the "events were dropped" signals
 * FSEvents gives (a `null` filename, or the watched folder's own name). A
 * handler for those (`on.unknown()` in `session-tree-watch.ts`) is not
 * exercised by a polled case.
 *
 * One copy for all of `apps/server`, because every module here resolves the
 * same `chokidar` and the same `node:fs`; another package needs its own (see
 * `packages/relay/src/__tests__/fake-watcher.ts`), since a spy patches only the
 * module object it is given.
 *
 * @module __tests__/watch-with-polling
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { vi } from 'vitest';

/** A polling substitution in force, until {@link PollingWatch.restore}. */
export interface PollingWatch<W> {
  /** Every watcher opened since the substitution began, in order. */
  readonly opened: readonly W[];
  /** Put the untouched function back. */
  restore(): void;
}

/**
 * Make `chokidar.watch()` use its POLLING backend until restored.
 *
 * Spreads the options production passed and adds only `usePolling` and the two
 * intervals, so the real chokidar, its real event names and the paths they
 * carry are all still under test. One thing polling does not reproduce: its
 * `raw` events carry `{ curr, prev }` stats, not the `{ watchedPath }` a native
 * watch reports, so a handler keyed on `watchedPath` never fires under it.
 *
 * @param intervalMs - How often chokidar re-stats.
 * @param onOpen - Sees each real watcher before it can emit anything, for a
 *   case that has to intercept what it reports.
 * @returns The substitution, with every real watcher it opened.
 */
export function watchWithPolling(
  intervalMs: number,
  onOpen?: (watcher: FSWatcher) => void
): PollingWatch<FSWatcher> {
  const real = chokidar.watch.bind(chokidar) as typeof chokidar.watch;
  const opened: FSWatcher[] = [];
  const spy = vi
    .spyOn(chokidar, 'watch')
    .mockImplementation((paths: unknown, options?: unknown): FSWatcher => {
      const watcher = real(paths as string, {
        ...((options ?? {}) as Record<string, unknown>),
        usePolling: true,
        interval: intervalMs,
        binaryInterval: intervalMs,
      });
      opened.push(watcher);
      onOpen?.(watcher);
      return watcher;
    });
  return { opened, restore: () => spy.mockRestore() };
}

/** One entry's identity: a directory by inode, a file by inode, size and mtime. */
type Listing = Map<string, string>;

/** Every entry under `root` (or directly in it), keyed by its path relative to `root`. */
function listingOf(root: string, recursive: boolean): Listing {
  const out: Listing = new Map();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(path.join(dir, entry.name));
      } catch {
        continue;
      }
      // A directory's own mtime moves whenever a child does; a native watch
      // names the child, not the directory, so neither does this.
      out.set(
        relPath,
        stats.isDirectory() ? `d:${stats.ino}` : `f:${stats.ino}:${stats.size}:${stats.mtimeMs}`
      );
      if (recursive && stats.isDirectory()) walk(path.join(dir, entry.name), relPath);
    }
  };
  walk(root, '');
  return out;
}

/**
 * A stand-in for the `fs.FSWatcher` `fs.watch` returns, fed by re-reading the
 * folder on an interval and reporting what differs, the way the platform does:
 * `rename` for an entry that appeared or went away, `change` for a file whose
 * contents changed, each with the path relative to the watched folder.
 */
class PollingFsWatcher extends EventEmitter {
  private readonly timer: NodeJS.Timeout;
  private last: Listing;

  constructor(
    private readonly root: string,
    private readonly recursive: boolean,
    intervalMs: number,
    persistent: boolean
  ) {
    super();
    this.last = listingOf(root, recursive);
    this.timer = setInterval(() => this.poll(), intervalMs);
    if (!persistent) this.timer.unref();
  }

  private poll(): void {
    const next = listingOf(this.root, this.recursive);
    const names = [...new Set([...this.last.keys(), ...next.keys()])].sort();
    const previous = this.last;
    this.last = next;
    for (const name of names) {
      const was = previous.get(name);
      const now = next.get(name);
      if (was === now) continue;
      const sameEntry =
        was !== undefined && now !== undefined && was.split(':')[1] === now.split(':')[1];
      this.emit('change', sameEntry ? 'change' : 'rename', name);
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.emit('close');
  }

  ref(): this {
    this.timer.ref();
    return this;
  }

  unref(): this {
    this.timer.unref();
    return this;
  }
}

/**
 * Make `fs.watch()` poll until restored.
 *
 * Arms the way the real one does — it throws `ENOENT` synchronously for a
 * folder that is not there — and honours `recursive` and `persistent`. The
 * listener production passed receives `(eventType, filename)` exactly as a
 * native watch would hand it, so production's own filtering is what runs.
 *
 * @param intervalMs - How often the folder is re-read.
 * @returns The substitution, with every watcher it opened.
 */
export function fsWatchWithPolling(intervalMs: number): PollingWatch<fs.FSWatcher> {
  const opened: fs.FSWatcher[] = [];
  const spy = vi.spyOn(fs, 'watch').mockImplementation(((
    target: fs.PathLike,
    options?: fs.WatchOptions | BufferEncoding | fs.WatchListener<string> | null,
    listener?: fs.WatchListener<string>
  ): fs.FSWatcher => {
    const onChange = typeof options === 'function' ? options : listener;
    const opts: fs.WatchOptions = typeof options === 'object' && options !== null ? options : {};
    const root = String(target);
    // The real one refuses a missing folder with ENOENT, synchronously.
    fs.statSync(root);
    const watcher = new PollingFsWatcher(
      root,
      opts.recursive === true,
      intervalMs,
      opts.persistent !== false
    );
    if (onChange) watcher.on('change', onChange);
    opened.push(watcher as unknown as fs.FSWatcher);
    return watcher as unknown as fs.FSWatcher;
  }) as typeof fs.watch);
  return { opened, restore: () => spy.mockRestore() };
}
