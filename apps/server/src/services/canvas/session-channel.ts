/**
 * How a session's canvas change reaches the windows watching that session (spec
 * `canvas-agent-seat` §1.3).
 *
 * **The projector is the right seam** because it is the one every runtime feeds:
 * claude-code, codex, opencode and test-mode each construct one, so a
 * server-minted `canvas` event reaches every runtime's readers without any of
 * them knowing a canvas exists. It is also what stamps the `seq` that makes the
 * event replayable, which is the whole reason a session needs no resync.
 *
 * `peekProjector` answering `undefined` — nobody attached, session idle — is the
 * NORMAL case and never an error: the row is already written, and the next
 * reader hydrates it from the cold snapshot.
 *
 * Its own module so `canvas-service.ts` imports no session code at all: the
 * service takes a channel, and this is the session half of one.
 *
 * @module server/services/canvas/session-channel
 */
import { peekProjector } from '../session/session-state-projector.js';
import type { CanvasFrame } from './canvas-service.js';

/**
 * Push one canvas frame onto a session's durable stream.
 *
 * @param sessionId - The session, by its canonical id.
 * @param frame - The frame every window of that session should apply.
 */
export function publishSessionCanvas(sessionId: string, frame: CanvasFrame): void {
  peekProjector(sessionId)?.ingest(frame);
}

/**
 * How many windows are reading this session's stream right now.
 *
 * Zero when nothing is attached, which is honest rather than unknown: nobody is
 * looking at a session whose stream nobody is reading.
 *
 * @param sessionId - The session.
 * @returns The live subscriber count.
 */
export function sessionCanvasViewers(sessionId: string): number {
  return peekProjector(sessionId)?.liveSubscriberCount() ?? 0;
}
