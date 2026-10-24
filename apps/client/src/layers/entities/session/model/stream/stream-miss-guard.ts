/**
 * Notice when the open chat's live stream misses a turn, and recover.
 *
 * Two streams describe the chat a window has open, and they should agree. The
 * fleet-wide `/api/events` stream announces every session's lifecycle
 * (`session_status`). The chat's own durable stream delivers the turn itself,
 * starting with `turn_start`. When the first says a turn is running and the
 * second has delivered nothing, the person is looking at a chat with no working
 * indicator and no reply, and only a refresh would show it.
 *
 * That disagreement is cheap to see from here, so this module watches for it on
 * the attached session and, when it holds, hands the session to
 * {@link streamManager.recoverSession}: the miss goes to the server log, and the
 * stream is rebuilt from a fresh snapshot, which shows the turn in progress or
 * the reply that already finished. Two moments are checked:
 *
 * - **Silent turn**: {@link SILENT_TURN_MS} after the server said a turn
 *   started, this window has applied nothing since and its own projection is
 *   not streaming.
 * - **Unrendered turn**: {@link SETTLE_GRACE_MS} after the server said that
 *   turn settled, this window still never heard any of it.
 *
 * "Heard" means the window applied a frame — snapshot or event — at or after
 * the moment the server said the turn started, give or take
 * {@link HEARD_SLACK_MS} for the two streams arriving in either order. A
 * working stream always delivers `turn_start`, so a long quiet tool call never
 * trips it.
 *
 * @module entities/session/model/stream/stream-miss-guard
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { streamManager } from '@/layers/shared/lib/transport';

import { useSessionStreamStore } from './session-stream-store';

/** How long a running turn may go unheard before the stream is rebuilt. */
export const SILENT_TURN_MS = 20_000;
/** How long after a turn settled the window waits for its frames to land. */
export const SETTLE_GRACE_MS = 3_000;
/** How far apart the two streams may report the same turn start. */
export const HEARD_SLACK_MS = 5_000;

/** Lifecycles in which a turn is open, so its `turn_start` must have arrived. */
const RUNNING: ReadonlySet<SessionLifecycle> = new Set(['streaming', 'blocked']);

/** The one turn being watched: the attached session's latest. */
interface Watch {
  sessionId: string;
  /** When the server said the turn started. */
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once this turn was reported, so it is never reported twice. */
  recovered: boolean;
}

let watch: Watch | null = null;

/** Whether the window applied any frame since the watched turn started. */
function heardSince(sessionId: string, since: number): boolean {
  const lastEventAt = useSessionStreamStore.getState().getSession(sessionId).lastEventAt;
  return lastEventAt !== null && lastEventAt >= since - HEARD_SLACK_MS;
}

/** Recover the watched session, once, if it is still the attached one. */
function recover(current: Watch, kind: 'silent-turn' | 'unrendered-turn'): void {
  if (current.recovered || streamManager.getAttachedSessionId() !== current.sessionId) return;
  current.recovered = true;
  streamManager.recoverSession(current.sessionId, {
    kind,
    silentMs: Math.max(0, Date.now() - current.since),
    lastSeq: useSessionStreamStore.getState().getSession(current.sessionId).lastAppliedSeq,
  });
}

/** The silent-turn check, run {@link SILENT_TURN_MS} after the turn started. */
function checkSilent(current: Watch): void {
  current.timer = null;
  if (watch !== current) return;
  const session = useSessionStreamStore.getState().getSession(current.sessionId);
  if (session.status !== null && RUNNING.has(session.status.lifecycle)) return;
  if (heardSince(current.sessionId, current.since)) return;
  recover(current, 'silent-turn');
}

/** The unrendered-turn check, run {@link SETTLE_GRACE_MS} after the turn settled. */
function checkSettled(current: Watch): void {
  current.timer = null;
  if (watch !== current) return;
  watch = null;
  if (heardSince(current.sessionId, current.since)) return;
  recover(current, 'unrendered-turn');
}

/**
 * Note a lifecycle the global stream announced, with the one it replaced. Only
 * the attached session is watched; anything else is ignored.
 *
 * @param sessionId - The session the announcement is for.
 * @param previous - Its lifecycle before this announcement, if one was held.
 * @param next - The lifecycle just announced.
 */
export function noteAnnouncedLifecycle(
  sessionId: string,
  previous: SessionLifecycle | undefined,
  next: SessionLifecycle
): void {
  if (sessionId !== streamManager.getAttachedSessionId()) return;
  const wasRunning = previous !== undefined && RUNNING.has(previous);
  if (RUNNING.has(next)) {
    if (wasRunning && watch?.sessionId === sessionId) return;
    resetStreamMissGuard();
    const current: Watch = { sessionId, since: Date.now(), timer: null, recovered: false };
    current.timer = setTimeout(() => checkSilent(current), SILENT_TURN_MS);
    watch = current;
    return;
  }
  const current = watch;
  if (!wasRunning || current?.sessionId !== sessionId) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => checkSettled(current), SETTLE_GRACE_MS);
}

/** Stop watching. Called on a fresh watch, and by tests. */
export function resetStreamMissGuard(): void {
  if (watch?.timer) clearTimeout(watch.timer);
  watch = null;
}
