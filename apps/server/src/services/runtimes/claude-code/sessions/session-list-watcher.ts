/**
 * Fleet-wide session-list watcher for the Claude Code adapter.
 *
 * Backs {@link ClaudeCodeRuntime.subscribeSessionList}: it emits one
 * `session_upserted` per session already on disk — across EVERY project slug
 * directory under `~/.claude/projects/` — then a `session_upserted` /
 * `session_removed` whenever a JSONL transcript appears, changes, or is deleted
 * in ANY of them, INCLUDING sessions created or appended by the Claude Code CLI
 * entirely outside DorkOS (ADR-0263). Each emitted session carries its true
 * `cwd` (read from the JSONL head, since the slug is lossy), which is how
 * multi-project clients route the event to the right list (SRV-I4). Emission is
 * on lifecycle transitions only; there is NO timer poll.
 *
 * The watch targets the projects ROOT directory with `depth: 1` and filters to
 * `.jsonl` files in the handler. It must NOT pass a glob to `chokidar.watch`:
 * chokidar v4 removed glob support, so a `{dir}/*.jsonl` pattern watches a
 * literal path that never exists and silently never fires (a real production
 * bug this module shipped with). Watching the root also picks up slug
 * directories created while the server runs.
 *
 * A new or removed slug dir (`addDir`/`unlinkDir`) additionally triggers a
 * rescan of that dir. This is the recovery path for a race: chokidar attaches a
 * new directory's own watch only AFTER its initial scan, so a per-file `add`
 * that lands in that scan-then-attach window is lost, not late. The dir-level
 * event fires from the long-lived root watch before that window, so its rescan
 * deterministically surfaces the first session in a brand-new project dir.
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
import { readdir } from 'fs/promises';
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

/** Compare two sessions on the fields that matter to the sidebar/global view. */
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
 * Watch the SDK projects root and yield session-list transitions for every
 * project. Yields the initial fleet-wide inventory as `session_upserted`s, then
 * live upserts/removals as transcripts change on disk anywhere under the root.
 * Runs until the consumer stops iterating (e.g. the broadcaster stops), at
 * which point the watcher is closed in `return()`.
 *
 * @param transcriptReader - Reader used to list/extract sessions per slug dir.
 * @param projectsRoot - The `~/.claude/projects` root to watch. Defaults to
 *   {@link TranscriptReader.getProjectsRoot}; injectable for tests.
 */
export function watchSessionList(
  transcriptReader: TranscriptReader,
  projectsRoot: string = transcriptReader.getProjectsRoot()
): AsyncIterableIterator<SessionListEvent> {
  // Last-known inventory per slug directory. Diffing is scoped per dir so a
  // re-scan of one project can never "remove" another project's sessions.
  const known = new Map<string, Map<string, Session>>();

  // Buffered events awaiting delivery, and the single waiter (if `next()` is
  // blocked on an empty queue). `closed` short-circuits delivery after `return()`.
  const queue: SessionListEvent[] = [];
  let waiter: ((result: IteratorResult<SessionListEvent>) => void) | null = null;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
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
    // window; the rescan recovers whatever landed. On `unlinkDir` the rescan
    // lists an absent dir as `[]`, emitting `session_removed` for its sessions.
    scheduleRescan(dirPath);
  };

  // Register the watch BEFORE the initial scan so externally-added files that
  // land during the first enumeration are not missed. NO glob (see module doc);
  // depth 1 = the root's slug dirs and the JSONL files directly inside them.
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

  // Initial fleet-wide inventory — emit every on-disk session once, project by
  // project (off the event loop so the caller can begin iterating immediately).
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

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: undefined, done: true });
    }
    await watcher.close();
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
