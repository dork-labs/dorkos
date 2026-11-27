/**
 * Opening one reader on the global event stream, `GET /api/events`: the same
 * steps for the SSE route (`routes/events.ts`) and the socket
 * (`routes/events-socket.ts`), written once so the two cannot drift.
 *
 * A reader is registered, then sent, in the same tick:
 *
 * 1. `connected`. On a resume it also says `resumed: true`.
 * 2. On a resume, every event after its cursor that it may read, with ids.
 * 3. The fleet's current session lifecycles (`session_status`, no ids).
 *
 * A cursor the replay window cannot serve (older than the window, from before a
 * restart, or for another stream) is a cold connect: steps 1 and 3 only, which
 * is the snapshot a reader rebuilds from.
 *
 * @module routes/global-events-connect
 */
import type { CallerPrincipal } from '../lib/caller-principal.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../services/core/event-fan-out.js';
import { sendSessionStatusSnapshot } from '../services/session/catalog/session-list-broadcaster.js';
import { connectedFramePayload } from '../services/session/catalog/session-list-reset.js';

/** The first part of every frame id on the global stream. */
export const GLOBAL_STREAM_RESOURCE_ID = 'events';

/**
 * Register a reader and send its opening frames.
 *
 * Registration comes first and nothing awaits before the last frame, so a
 * broadcast can neither be missed nor land ahead of the replay it follows.
 *
 * @param client - The reader.
 * @param principal - Who the reader is; replay filters by it as live writes do.
 * @param cursor - The `Last-Event-ID` header or `?resume=` value, if any.
 * @returns The unsubscribe function.
 */
export function openGlobalStream(
  client: FanOutClient,
  principal: CallerPrincipal,
  cursor: string | undefined
): () => void {
  const answer = eventFanOut.resumeFor(
    parseResumeCursor(cursor, undefined, { resourceId: GLOBAL_STREAM_RESOURCE_ID })
  );
  const unsubscribe = eventFanOut.addClient(client, principal);
  const resumed = answer.kind === 'replay';
  client.send(
    encodeBroadcast('connected', {
      ...connectedFramePayload(),
      ...(resumed && { resumed: true }),
    })
  );
  if (resumed) eventFanOut.replayTo(client, principal, answer.entries);
  sendSessionStatusSnapshot(client, principal);
  return unsubscribe;
}
