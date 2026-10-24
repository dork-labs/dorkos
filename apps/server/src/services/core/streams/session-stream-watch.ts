/**
 * Who is watching each chat's live stream, and a warning when that count and
 * the session's live feed disagree.
 *
 * A window watches a chat over one durable stream, and that stream reads one
 * projector — the session's in-memory feed of events. The two counts here are
 * kept apart on purpose:
 *
 * - **Open streams** ({@link openSessionStreamCount}): every app window holding
 *   this chat's `/events` stream open, counted by this module as streams open
 *   and close, whichever projector they read.
 * - **Live subscribers** (`SessionStateProjector.liveSubscriberCount`): the
 *   streams reading the projector a turn is about to be fed into.
 *
 * They match whenever streaming works. They disagree in exactly one shape worth
 * shouting about: a turn starts on a projector nobody is reading, while a window
 * still holds this chat's stream open. That window is reading a feed nothing
 * will ever write to again, so the turn runs and the window shows nothing until
 * somebody refreshes. It is how an evicted session's projector stranded its
 * readers until eviction learned to end their streams (`disposeProjector`), and
 * the warning below is what says so if any other path ever does it again.
 *
 * @module services/core/streams/session-stream-watch
 */
import { logger } from '../../../lib/logger.js';
import { onProjectorStatusChange, peekProjector } from '../../session/session-state-projector.js';

/** Open durable streams per chat id. A stream counts under every id it answers to. */
const openStreams = new Map<string, number>();

/**
 * Count one open durable stream for a chat, under every id it answers to.
 *
 * @param ids - The chat's ids: the one the window asked for and the runtime's
 *   own, when they differ.
 * @returns Releases the count. Safe to call more than once.
 */
export function openSessionStream(ids: readonly string[]): () => void {
  const unique = [...new Set(ids)];
  for (const id of unique) openStreams.set(id, (openStreams.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of unique) {
      const left = (openStreams.get(id) ?? 1) - 1;
      if (left > 0) openStreams.set(id, left);
      else openStreams.delete(id);
    }
  };
}

/**
 * How many app windows hold this chat's durable stream open right now.
 *
 * @param sessionId - Either of the chat's ids.
 */
export function openSessionStreamCount(sessionId: string): number {
  return openStreams.get(sessionId) ?? 0;
}

/**
 * Warn when a turn starts that no open window will see.
 *
 * Fires on the move into `streaming` only, so one warning per turn at most.
 * Only the server's boot calls this.
 *
 * @returns Stops watching.
 */
export function watchSessionStreamHealth(): () => void {
  return onProjectorStatusChange(({ sessionId, status }) => {
    if (status.lifecycle !== 'streaming') return;
    const openWindows = openSessionStreamCount(sessionId);
    if (openWindows === 0) return;
    const liveSubscribers = peekProjector(sessionId)?.liveSubscriberCount() ?? 0;
    if (liveSubscribers > 0) return;
    logger.warn('[session stream] a turn started that no open window will see', {
      sessionId,
      openWindows,
      liveSubscribers,
    });
  });
}

/** Forget every count. Test-only. */
export function __resetSessionStreamWatchForTests(): void {
  openStreams.clear();
}
