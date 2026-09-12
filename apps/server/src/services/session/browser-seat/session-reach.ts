/**
 * How a `ui` verb reaches the windows of the session that called it, from a
 * session id and nothing else (spec `canvas-agent-seat` §5).
 *
 * Every one of these verbs ends in something a WINDOW does: reveal a pane,
 * rasterize a frame, click a button. The server's half is one event on the
 * session's durable stream, which every window open on that session is already
 * reading.
 *
 * ## Why the projector, and not a per-turn event queue
 *
 * The queue is a runtime's own: claude-code hands its tool server a live
 * `AgentSession` with an array on it, and Codex and OpenCode are separate
 * programs with no such object to hand anybody. The projector is the one thing
 * all three share — it is what the runtime's events are ingested INTO — so
 * addressing it directly is what makes one handler serve every runtime. It is
 * also redirect-aware, so a session addressed by either of its ids reaches the
 * same stream.
 *
 * The events themselves are unchanged: the same three transient, side-effecting
 * members the queue used to carry, in the same shape the queue's normalizer
 * produced. What is gone is the hop.
 *
 * @module services/session/browser-seat/session-reach
 */
import { peekProjector, type RawSessionEvent } from '../session-state-projector.js';

/**
 * Push one event onto a session's durable stream, if that session is live.
 *
 * @param sessionId - The calling session, from the verified capability context.
 * @param event - A transient session event: a UI command, or a request to the
 *   window holding a preview.
 * @returns `true` when a live stream took it, `false` when this session has
 *   none. A caller that needs the window to answer treats `false` as "no window
 *   to reach" rather than waiting out a timeout nothing was going to answer.
 */
export function emitToSession(sessionId: string, event: RawSessionEvent): boolean {
  const projector = peekProjector(sessionId);
  if (!projector) return false;
  projector.ingest(event);
  return true;
}
