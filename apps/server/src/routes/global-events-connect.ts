/**
 * Opening one reader on the global event stream, `GET /api/events`: the same
 * steps for the SSE route (`routes/events.ts`) and the socket
 * (`routes/events-socket.ts`), written once so the two cannot drift.
 *
 * A reader is registered, then sent, in the same tick:
 *
 * 1. `connected`. On a resume it also says `resumed: true`.
 * 2. On a resume, every event after its cursor that it may read, with ids.
 * 3. The tunnel's current status (`tunnel_status`, no id), so nobody needs a
 *    second call to learn it.
 * 4. The fleet's current session lifecycles (`session_status`, no ids).
 *
 * A cursor the replay window cannot serve (older than the window, from before a
 * restart, or for another stream) is a cold connect: steps 1, 3 and 4 only,
 * which is the snapshot a reader rebuilds from.
 *
 * ## Only a person reads it
 *
 * The stream is a person's (DOR-4986, Security's ruling): both routes run
 * {@link admitEventsReader}, which is the person bar itself (`assessPerson`),
 * never a copy. An agent identity or an approval token is refused in every
 * posture; a key alone passes while login is off and is refused while it is on;
 * a page on another site, a mini app's frame (`Origin: null`) included, is
 * refused. Agents read what they need through their own tools.
 *
 * ## Rights are asked as each frame goes out
 *
 * A reader's rights are never captured: not when an event happened, not when the
 * stream opened, not from a cursor. Each frame, live or replayed, asks the
 * event's audience about this reader at the moment it is written
 * (`services/core/event-fan-out.ts`), so a room the reader has left stops
 * reaching them from the next frame on. A cursor is only a place in the stream:
 * one taken from another reader's stream replays only what the RESUMING reader
 * may read.
 *
 * @module routes/global-events-connect
 */
import { problemBody } from '@dorkos/http-kit';
import type { RequestFacts } from '../http/request-facts.js';
import {
  isPersonPrincipal,
  readCallerPrincipal,
  type PersonPrincipal,
} from '../lib/caller-principal.js';
import { assessPerson, type PersonBarCopy, type PersonRefusal } from '../lib/http/person-bar.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../services/core/event-fan-out.js';
import { sendSessionStatusSnapshot } from '../services/session/catalog/session-list-broadcaster.js';
import { connectedFramePayload } from '../services/session/catalog/session-list-reset.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/** The first part of every frame id on the global stream. */
export const GLOBAL_STREAM_RESOURCE_ID = 'events';

/** What `GET /api/events` says to a caller that is not a person, on SSE and the socket alike. */
export const EVENTS_PERSON_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'what the app shows live',
  agent: 'Only a person can open the app’s live updates. Agents use their own tools.',
};

/** A reader the stream admits, or the person bar's refusal. */
export type EventsAdmission =
  | { readonly ok: true; readonly reader: PersonPrincipal }
  | { readonly ok: false; readonly refusal: PersonRefusal };

/**
 * Run the person bar over a connect, and name the person it admits.
 *
 * @param facts - The request's facts: from the chain for SSE, from the upgrade
 *   for the socket (`upgradeRequestFacts`).
 * @returns The reader, or the refusal to answer with.
 */
export function admitEventsReader(facts: RequestFacts): EventsAdmission {
  const refusal = assessPerson(facts, EVENTS_PERSON_BAR);
  if (refusal) return { ok: false, refusal };
  const reader = readCallerPrincipal(facts);
  if (isPersonPrincipal(reader)) return { ok: true, reader };
  // The bar refuses everything that reads as an agent, so this is never reached;
  // it fails closed rather than trusting that it is never reached.
  const body = problemBody(EVENTS_PERSON_BAR.code, { detail: EVENTS_PERSON_BAR.agent });
  return { ok: false, refusal: { status: body.status, body } };
}

/**
 * Register a reader and send its opening frames.
 *
 * Registration comes first and nothing awaits before the last frame, so a
 * broadcast can neither be missed nor land ahead of the replay it follows.
 *
 * @param client - The reader.
 * @param principal - The person reading, from {@link admitEventsReader}; replay
 *   filters by it as live writes do.
 * @param cursor - The `Last-Event-ID` header or `?resume=` value, if any.
 * @returns The unsubscribe function.
 */
export function openGlobalStream(
  client: FanOutClient,
  principal: PersonPrincipal,
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
  // After any replay, so the last tunnel frame a reader holds is the current one.
  // Every reader here is a person, whom front-door state is for.
  client.send(encodeBroadcast('tunnel_status', tunnelManager.status));
  sendSessionStatusSnapshot(client, principal);
  return unsubscribe;
}
