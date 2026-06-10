/**
 * Global session-list watcher for the Claude Code adapter.
 *
 * Backs {@link ClaudeCodeRuntime.subscribeSessionList}: it emits one
 * `session_upserted` per session already on disk, then a `session_upserted` /
 * `session_removed` whenever a JSONL transcript appears, changes, or is deleted
 * under `~/.claude/projects/{slug}/` — INCLUDING sessions created or appended by
 * the Claude Code CLI entirely outside DorkOS (ADR-0263). Emission is on
 * lifecycle transitions only; there is NO timer poll.
 *
 * The directory watch is debounced ({@link SESSION_LIST_DEBOUNCE_MS}) so a turn
 * that appends many JSONL lines collapses into a single re-scan, and the
 * resulting `session_upserted` is suppressed when the session's projected
 * metadata is byte-for-byte unchanged (so a metadata-irrelevant append does not
 * spam the global stream).
 *
 * `session_status` events are NOT emitted here — per-session status flows over
 * `subscribeSession`/the projector. Task #7 fans this generator into the global
 * SSE stream; it can iterate it directly.
 *
 * @module services/runtimes/claude-code/sessions/session-list-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'path';
import type { Session } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { TranscriptReader } from './transcript-reader.js';
import { WATCHER } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Debounce window for the session-list directory watch (ms). One streaming turn
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
 * Watch the Claude projects directory for a `projectDir` and yield session-list
 * transitions. Yields the initial inventory as `session_upserted`s, then live
 * upserts/removals as transcripts change on disk. Runs until the consumer stops
 * iterating (e.g. the SSE client disconnects), at which point the watcher is
 * closed in the `finally`.
 *
 * @param transcriptReader - Reader used to resolve the transcripts dir and list sessions.
 * @param projectDir - Project root whose `~/.claude/projects/{slug}/` is watched.
 */
export function watchSessionList(
  transcriptReader: TranscriptReader,
  projectDir: string
): AsyncIterableIterator<SessionListEvent> {
  const transcriptsDir = transcriptReader.getTranscriptsDir(projectDir);
  const known = new Map<string, Session>();

  // Buffered events awaiting delivery, and the single waiter (if `next()` is
  // blocked on an empty queue). `closed` short-circuits delivery after `return()`.
  const queue: SessionListEvent[] = [];
  let waiter: ((result: IteratorResult<SessionListEvent>) => void) | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
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

  const rescan = async (): Promise<void> => {
    try {
      const out: SessionListEvent[] = [];
      diffInventory(known, await transcriptReader.listSessions(projectDir), out);
      for (const event of out) push(event);
    } catch (err) {
      logger.warn('[session-list-watcher] rescan failed', {
        projectDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scheduleRescan = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void rescan();
    }, SESSION_LIST_DEBOUNCE_MS);
  };

  // Register the watch BEFORE the initial scan so externally-added files that
  // land during the first listSessions() are not missed.
  const watcher: FSWatcher = chokidar.watch(join(transcriptsDir, '*.jsonl'), {
    persistent: true,
    ignoreInitial: true, // initial inventory delivered by the scan below
    awaitWriteFinish: {
      stabilityThreshold: WATCHER.STABILITY_THRESHOLD_MS,
      pollInterval: WATCHER.POLL_INTERVAL_MS,
    },
  });
  watcher.on('add', scheduleRescan);
  watcher.on('change', scheduleRescan);
  watcher.on('unlink', scheduleRescan);

  // Initial inventory — emit every on-disk session once (off the event loop so
  // the caller can begin iterating immediately).
  void (async () => {
    try {
      const out: SessionListEvent[] = [];
      diffInventory(known, await transcriptReader.listSessions(projectDir), out);
      for (const event of out) push(event);
    } catch (err) {
      logger.warn('[session-list-watcher] initial scan failed', {
        projectDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
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
