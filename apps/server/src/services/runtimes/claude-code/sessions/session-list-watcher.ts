/**
 * Fleet-wide session-list watcher for the Claude Code adapter.
 *
 * Backs {@link ClaudeCodeRuntime.subscribeSessionList}: it emits one
 * `session_upserted` per session already on disk — across EVERY project slug
 * directory under EVERY Claude account's `projects/` — then a `session_upserted`
 * / `session_removed` whenever a JSONL transcript appears, changes, or is deleted
 * in ANY of them, INCLUDING sessions created or appended by the Claude Code CLI
 * entirely outside DorkOS (ADR-0263). Each emitted session carries its true
 * `cwd` (read from the JSONL head, since the slug is lossy), which is how
 * multi-project clients route the event to the right list (SRV-I4), and the
 * account it belongs to. Emission is on lifecycle transitions only — nothing is
 * emitted unless a session actually appeared, changed or went away.
 *
 * The watch targets each projects ROOT directory with `depth: 1` and filters to
 * `.jsonl` files in the handler. It must NOT pass a glob to `chokidar.watch`:
 * chokidar v4 removed glob support, so a `{dir}/*.jsonl` pattern watches a
 * literal path that never exists and silently never fires (a real production
 * bug this module shipped with). Watching the root also picks up slug
 * directories created while the server runs.
 *
 * A new or removed slug dir (`addDir`/`unlinkDir`) additionally triggers a
 * rescan of that dir, which is how the first session in a brand-new project
 * reaches the list without waiting for a per-file event.
 *
 * CHOKIDAR IS THE FAST PATH, NOT THE SOURCE OF TRUTH. `chokidar.watch()`
 * returns before it has attached anything: it scans the root first and only
 * then calls `fs.watch` on it (`handler.js` `_handleDir` — the read is awaited,
 * the watch comes after). Anything created inside that window is invisible
 * FOREVER — measured on the installed chokidar 5.0.0, a project dir created in
 * the same tick as `watch()` produced no `addDir` and no `add` in 35 of 35
 * runs, and no `raw` event either in 32 of them, so there is nothing to recover
 * from and no amount of re-writing the file helps (the file is not watched
 * either, so it fires nothing when it changes). The window is
 * proportional to the size of the projects tree and to how busy the machine is,
 * which is why this surfaced as a load-dependent flake (DOR-577) rather than a
 * constant failure. So a periodic reconcile sweep ({@link
 * SESSION_LIST_RECONCILE_MS}) re-derives the truth from disk: one `readdir` of
 * each root plus one `stat` per slug dir, rescanning only the dirs whose mtime
 * moved since the previous sweep and the ones that have disappeared. A slug
 * dir's mtime changes whenever a transcript is created or deleted in it, so the
 * sweep costs a couple of syscalls per project and emits nothing at all when
 * nothing changed. Emission stays transition-only; the sweep is a source of
 * rescans, never of events.
 *
 * Rescans are debounced PER SLUG DIRECTORY ({@link SESSION_LIST_DEBOUNCE_MS})
 * so a streaming turn's JSONL append burst collapses into one re-scan of just
 * that project, and the resulting `session_upserted` is suppressed when the
 * session's projected metadata is byte-for-byte unchanged.
 *
 * `session_status` events are NOT emitted here — per-session status flows over
 * `subscribeSession`/the projector. The session-list broadcaster fans this
 * generator into the global SSE stream.
 *
 * @module services/runtimes/claude-code/sessions/session-list-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { readdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { Session } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { TranscriptReader } from './transcript-reader.js';
import { WATCHER } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Debounce window for each slug directory's re-scan (ms). One streaming turn
 * fsync-appends to a JSONL many times a second; this collapses that burst into a
 * single re-scan. Deliberately a touch longer than the per-session
 * {@link WATCHER.DEBOUNCE_MS} because a list re-scan is heavier than a tail read.
 */
export const SESSION_LIST_DEBOUNCE_MS = 250;

/**
 * Gap between reconcile sweeps (ms) — the worst-case delay before a session
 * chokidar never reported reaches the list anyway (see the module doc).
 *
 * This is a ceiling on a recovery, not the normal path: when chokidar does its
 * job the event arrives in milliseconds and the sweep finds nothing to do. Five
 * seconds keeps a dropped session inside the window where a person is still
 * looking at the screen that should have shown it, while leaving the steady-state
 * cost at one `readdir` plus one `stat` per project every five seconds — a few
 * milliseconds even for someone with hundreds of projects.
 */
export const SESSION_LIST_RECONCILE_MS = 5_000;

/**
 * Compare two sessions on the fields that matter to the sidebar/global view.
 *
 * `account` is deliberately absent, like `runtime`, `origin` and `cwd`: a
 * session's account is the directory its transcript lives under, and a transcript
 * cannot move between accounts, so the value can never differ between two
 * readings of the same session. Comparing it would only cost work. It is listed
 * here rather than merely omitted so the next reader knows the omission was a
 * decision (spec `claude-code-accounts` §8).
 */
function sessionMetaEqual(a: Session, b: Session): boolean {
  return (
    a.title === b.title &&
    a.updatedAt === b.updatedAt &&
    a.lastMessagePreview === b.lastMessagePreview &&
    a.permissionMode === b.permissionMode &&
    a.model === b.model &&
    a.contextTokens === b.contextTokens
  );
}

/**
 * Diff a fresh inventory against the last-known one, mutating `known` in place
 * and pushing the resulting `session_upserted`/`session_removed` events.
 */
function diffInventory(
  known: Map<string, Session>,
  fresh: Session[],
  out: SessionListEvent[]
): void {
  const seen = new Set<string>();
  for (const session of fresh) {
    seen.add(session.id);
    const prev = known.get(session.id);
    if (!prev || !sessionMetaEqual(prev, session)) {
      known.set(session.id, session);
      out.push({ type: 'session_upserted', session });
    }
  }
  for (const id of Array.from(known.keys())) {
    if (!seen.has(id)) {
      known.delete(id);
      out.push({ type: 'session_removed', sessionId: id });
    }
  }
}

/**
 * The modification time of `dirPath` in milliseconds, or `undefined` when it is
 * not a readable directory — it was deleted (the normal end of a project's
 * life), it is a stray file sitting in the projects root, or it cannot be
 * stat'd at all.
 *
 * `stat` rather than the `readdir` dirent: it follows symlinks, so a slug dir
 * that is a symlink to a directory elsewhere is treated as the directory it
 * points at, the same reading {@link TranscriptReader.listSessionsInDir} gives.
 */
async function dirMtime(dirPath: string): Promise<number | undefined> {
  try {
    const stats = await stat(dirPath);
    return stats.isDirectory() ? stats.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Watch every Claude account's projects root and yield session-list transitions
 * for every project. Yields the initial fleet-wide inventory as
 * `session_upserted`s, then live upserts/removals as transcripts change on disk
 * anywhere under any of the roots. Runs until the consumer stops iterating (e.g.
 * the broadcaster stops), at which point every watcher is closed in `return()`.
 *
 * One chokidar watcher per root, each capturing its OWN root for the
 * child-of-root guards in its handlers: a single shared capture would compare a
 * second account's file events against the first account's root and drop them as
 * "not a slug dir". The queue, the debounce timers and the last-known inventory
 * stay shared and need no per-root partitioning — both maps are keyed by absolute
 * directory path, so entries from different accounts cannot collide.
 *
 * @param transcriptReader - Reader used to list/extract sessions per slug dir.
 * @param projectsRoots - The `{claudeRoot}/projects` roots to watch, one per
 *   account. Defaults to {@link TranscriptReader.getProjectsRootSet};
 *   injectable for tests. An empty array watches nothing and yields nothing,
 *   which is the correct answer on a machine with no Claude account (spec §9).
 */
export function watchSessionList(
  transcriptReader: TranscriptReader,
  projectsRoots: string[] = transcriptReader.getProjectsRootSet()
): AsyncIterableIterator<SessionListEvent> {
  // Last-known inventory per slug directory, keyed by ABSOLUTE path so the same
  // project under two accounts is two independent entries. Diffing is scoped per
  // dir so a re-scan of one project can never "remove" another project's
  // sessions — nor another account's copy of the same project.
  const known = new Map<string, Map<string, Session>>();

  // The mtime each slug dir had at the sweep that last scheduled a rescan for
  // it, keyed by absolute path. Only the sweep writes here, and it writes the
  // mtime it OBSERVED, before the rescan it triggers has run: anything landing
  // in between leaves the dir looking changed again next sweep, so the error is
  // always one rescan too many rather than one too few. A dir missing from this
  // map has never been swept — the state a chokidar-dropped directory is in.
  const dirMtimes = new Map<string, number>();

  // Buffered events awaiting delivery, and the single waiter (if `next()` is
  // blocked on an empty queue). `closed` short-circuits delivery after `return()`.
  const queue: SessionListEvent[] = [];
  let waiter: ((result: IteratorResult<SessionListEvent>) => void) | null = null;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let sweepTimer: NodeJS.Timeout | undefined;
  let closed = false;

  /** Hand `event` to a blocked consumer, or buffer it for the next `next()`. */
  const push = (event: SessionListEvent): void => {
    if (closed) return;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  /** Re-list one slug dir and emit the diff against its last-known inventory. */
  const rescanDir = async (transcriptsDir: string): Promise<void> => {
    try {
      let knownForDir = known.get(transcriptsDir);
      if (!knownForDir) {
        knownForDir = new Map();
        known.set(transcriptsDir, knownForDir);
      }
      const out: SessionListEvent[] = [];
      diffInventory(knownForDir, await transcriptReader.listSessionsInDir(transcriptsDir), out);
      for (const event of out) push(event);
    } catch (err) {
      logger.warn('[session-list-watcher] rescan failed', {
        transcriptsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** Debounce per slug dir: a burst in one project re-scans only that project. */
  const scheduleRescan = (transcriptsDir: string): void => {
    const existing = debounceTimers.get(transcriptsDir);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      transcriptsDir,
      setTimeout(() => {
        debounceTimers.delete(transcriptsDir);
        void rescanDir(transcriptsDir);
      }, SESSION_LIST_DEBOUNCE_MS)
    );
  };

  /**
   * Re-derive one root's slug dirs from disk and rescan the ones that moved.
   *
   * This is the half of the watcher that does not believe chokidar (module
   * doc). It reads the root once and stats each child; a dir whose mtime moved
   * since the previous sweep has gained or lost a transcript, and a dir the
   * sweep has never seen is one chokidar never reported. Both get the same
   * debounced rescan a chokidar event would have triggered, so an unchanged
   * tree costs one `readdir` plus one `stat` per project and emits nothing.
   *
   * Appends to an existing transcript deliberately do NOT move a directory's
   * mtime and so do not show up here — the per-file watch chokidar attached
   * when it first saw the file carries those, and a sweep that re-listed every
   * project on every turn would be a poll of the whole tree rather than a
   * backstop.
   */
  const sweepRoot = async (projectsRoot: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(projectsRoot);
    } catch (err) {
      // A missing projects root is the normal first-run state, same as in the
      // initial scan; anything else is worth one line per sweep.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[session-list-watcher] reconcile sweep failed', {
          projectsRoot,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const present = new Set<string>();
    for (const name of names) {
      if (closed) return;
      const dir = join(projectsRoot, name);
      const mtimeMs = await dirMtime(dir);
      // Not a readable directory — a stray file in the projects root, or an
      // entry that vanished between the readdir and the stat. Left out of
      // `present` so it is never taken for a live slug dir, and never rescanned,
      // because listing a non-directory only produces a warning.
      if (mtimeMs === undefined) continue;
      present.add(dir);
      if (dirMtimes.get(dir) === mtimeMs) continue;
      dirMtimes.set(dir, mtimeMs);
      scheduleRescan(dir);
    }
    // A slug dir that vanished without an `unlinkDir` still owes its sessions a
    // `session_removed`; the rescan lists the absent dir as `[]` and emits them.
    // Driven off `known` rather than the sweep's own ledger so a project deleted
    // before the first sweep is covered too, and skipped once the dir holds no
    // sessions, so a long-gone project is not re-listed every five seconds.
    for (const [dir, sessions] of known) {
      if (dirname(dir) !== projectsRoot || present.has(dir) || sessions.size === 0) continue;
      dirMtimes.delete(dir);
      scheduleRescan(dir);
    }
  };

  /**
   * Run the next sweep across every root, then queue the one after it. A
   * self-rescheduling timeout rather than an interval: a sweep of a large tree
   * on a busy machine can outlast the gap, and sweeps must not overlap.
   */
  const scheduleSweep = (): void => {
    if (closed || projectsRoots.length === 0) return;
    sweepTimer = setTimeout(() => {
      void (async () => {
        for (const projectsRoot of projectsRoots) {
          if (closed) return;
          await sweepRoot(projectsRoot);
        }
        scheduleSweep();
      })();
    }, SESSION_LIST_RECONCILE_MS);
  };

  /**
   * Attach one account's watcher and kick off its initial inventory. Every guard
   * below closes over THIS root, which is what keeps N accounts from
   * misattributing each other's events.
   */
  const watchRoot = (projectsRoot: string): FSWatcher => {
    /** Route a chokidar file event to its slug dir's debounced re-scan. */
    const onFileEvent = (filePath: string): void => {
      if (!filePath.endsWith('.jsonl')) return;
      const transcriptsDir = dirname(filePath);
      // Transcripts live one level down ({root}/{slug}/{id}.jsonl); a stray
      // .jsonl directly in the root is not a session and must not trigger a
      // re-scan of the root itself as if it were a slug dir.
      if (transcriptsDir === projectsRoot) return;
      scheduleRescan(transcriptsDir);
    };

    /** Route a slug dir appearing/disappearing to its debounced re-scan. */
    const onDirEvent = (dirPath: string): void => {
      // Only immediate children of the root are slug dirs; this guard also
      // excludes the root itself and anything deeper.
      if (dirname(dirPath) !== projectsRoot) return;
      // chokidar attaches a new dir's own fs.watch only AFTER scanning it, so a
      // file created in that scan-then-attach window emits no per-file `add` (lost,
      // not late). This `addDir` fires from the long-lived root watch before that
      // window, so its rescan recovers whatever landed — when the root watch is
      // live at all. When it is not, this handler never runs and the reconcile
      // sweep is what finds the directory. On `unlinkDir` the rescan lists an
      // absent dir as `[]`, emitting `session_removed` for its sessions.
      scheduleRescan(dirPath);
    };

    // Asking for the watch here does NOT mean it is armed here: chokidar scans
    // the root before it calls `fs.watch` on it, and everything created in
    // between is invisible to it forever (module doc). The reconcile sweep, not
    // the ordering of these lines, is what covers that window. NO glob (see
    // module doc); depth 1 = the root's slug dirs and the JSONL files directly
    // inside them.
    const watcher: FSWatcher = chokidar.watch(projectsRoot, {
      persistent: true,
      ignoreInitial: true, // initial inventory delivered by the scan below
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: WATCHER.STABILITY_THRESHOLD_MS,
        pollInterval: WATCHER.POLL_INTERVAL_MS,
      },
    });
    watcher.on('add', onFileEvent);
    watcher.on('change', onFileEvent);
    watcher.on('unlink', onFileEvent);
    watcher.on('addDir', onDirEvent);
    watcher.on('unlinkDir', onDirEvent);

    // A dead root watcher means this account's session list silently stops
    // tracking new, changed and removed sessions — everything downstream (the
    // sidebar, the global view) freezes on stale data with no other signal.
    // Without this handler the failure (e.g. EMFILE) has nowhere to go but the
    // process-wide unhandled-error path, which never names the watcher that
    // died. Logged at error rather than the warn this module uses for a failed
    // scan: a failed scan retries on the next event, a dead watcher never fires
    // again.
    //
    // This root watch spans every project dir, so a single fd-exhaustion
    // episode can make chokidar fire 'error' once per directory it fails to
    // (re-)watch — hundreds of times for a real projects tree. Latched per
    // distinct error code rather than a single boolean: a benign EACCES on one
    // stale project dir must never suppress the EMFILE storm that follows it.
    // `code` is the actionable field — EMFILE, ENOSPC and EPERM mean different
    // fixes. The Set lives in this per-root closure, so one account's latch
    // cannot silence another account's.
    const seenCodes = new Set<string>();
    watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Logged as an explicit object, never the bare Error: the NDJSON reporter
      // spreads what it is given, and `message`/`stack` are non-enumerable on
      // an Error, so they would vanish (DOR-832).
      logger.error(
        `[watcher-error] session-list-watcher — further ${code} errors from this watcher are suppressed`,
        {
          projectsRoot,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });

    // Initial fleet-wide inventory for this account — emit every on-disk session
    // once, project by project (off the event loop so the caller can begin
    // iterating immediately).
    void (async () => {
      try {
        const entries = await readdir(projectsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (closed) return;
          if (!entry.isDirectory()) continue;
          await rescanDir(join(projectsRoot, entry.name));
        }
      } catch (err) {
        // A missing projects root is the normal first-run state — Claude Code has
        // never written a transcript on this machine, so there is nothing to list
        // yet. The watch registered above stays armed and picks the directory up
        // the moment the first session creates it; WARN is reserved for scans
        // that fail on a root that exists (DOR-247).
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.debug('[session-list-watcher] no sessions yet; projects directory not created', {
            projectsRoot,
          });
          return;
        }
        logger.warn('[session-list-watcher] initial scan failed', {
          projectsRoot,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return watcher;
  };

  const watchers = projectsRoots.map(watchRoot);
  scheduleSweep();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = undefined;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: undefined, done: true });
    }
    await Promise.all(watchers.map((watcher) => watcher.close()));
  };

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<SessionListEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    async return(): Promise<IteratorResult<SessionListEvent>> {
      await close();
      return { value: undefined, done: true };
    },
  };
}
