/**
 * Test helpers for the trigger-only message POST + durable `/events` stream
 * (ADR-0264). They model the new client contract: POST to trigger a turn, then
 * read the turn back over `GET /:id/events` — the single delivery path.
 *
 * @module routes/__tests__/helpers/trigger-turn-helpers
 */
import http from 'node:http';
import request from 'supertest';

/** A single SSE frame parsed off the `/events` wire, with its optional `id:`. */
export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/** Parse SSE wire text into frames, attaching the most recent `id:` to each. */
export function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let id: string | undefined;
  let event = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) {
      id = line.slice(4).trim();
    } else if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ') && event) {
      frames.push({ id, event, data: JSON.parse(line.slice(6)) });
      id = undefined;
      event = '';
    }
  }
  return frames;
}

/** A collected `/events` response: parsed frames, raw text, and the status. */
export interface EventsResult {
  frames: SseFrame[];
  raw: string;
  status: number;
}

/**
 * A live attachment to `GET /api/sessions/:id/events`: collects frames until a
 * terminator is seen and exposes a promise that resolves with the result, plus
 * hooks to know when the snapshot has arrived and to force-close.
 */
export interface EventStreamHandle {
  /** Resolves once the connection is open and the cold snapshot frame arrived. */
  ready: Promise<void>;
  /** Resolves when the terminator is seen / the stream ends / `maxMs` elapses. */
  done: Promise<EventsResult>;
  /** Force-close (used by callers that don't expect a terminator). */
  close(): void;
}

/**
 * Attach to `GET /:id/events` and stream frames into a buffer, resolving `done`
 * when `until` is reached (or the stream ends / `maxMs` elapses). `until` is an
 * `event:` name by default — pass a predicate over the raw SSE text for a stop
 * condition one name cannot express, such as a connection that must survive TWO
 * turns and so cannot close on the first `turn_end`. The
 * `ready` promise resolves once the cold `snapshot` frame has been received so
 * callers can trigger a turn only after the live subscription exists — the
 * subscribe-first ordering the real client uses (so it cannot miss `turn_start`).
 * Exported for multi-consumer tests that need two concurrent attachments with
 * independent ready/done control (cross-client convergence pins).
 *
 * Takes an ALREADY-LISTENING server (from `listeningServer(app)`), not an app.
 * It used to take the app and `listen(0)` per call, which churned an ephemeral
 * port per attachment — and did so in files that also drive supertest, so a
 * pooled keep-alive socket could be handed to a request meant for a port that
 * had since been reclaimed by a different listener (DOR-483).
 */
export function attachEventStream(
  server: http.Server,
  sessionId: string,
  opts: { until?: string | ((raw: string) => boolean); maxMs?: number } = {}
): EventStreamHandle {
  const until = opts.until ?? 'turn_end';
  const reached =
    typeof until === 'function' ? until : (raw: string) => raw.includes(`event: ${until}`);
  const maxMs = opts.maxMs ?? 4000;
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    throw new Error(
      'attachEventStream: server is not listening — pass the server from listeningServer(app)'
    );
  }
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  let forceClose: () => void = () => {};
  const done = new Promise<EventsResult>((resolve, reject) => {
    let raw = '';
    let settled = false;
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      signalReady();
      resolve({ frames: parseFrames(raw), raw, status });
    };
    forceClose = () => finish(200);
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/sessions/${sessionId}/events`, method: 'GET' },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.on('data', (c: Buffer) => (raw += c.toString()));
          res.on('end', () => finish(status));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          if (raw.includes('event: snapshot')) signalReady();
          if (reached(raw)) finish(200);
        });
        res.on('end', () => finish(200));
      }
    );
    const timer = setTimeout(() => finish(200), maxMs);
    req.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('events request errored'));
      }
    });
    req.end();
  });
  // A caller can stop watching `done` before it settles — the outer test
  // hit ITS OWN timeout first and moved on (a real race under CPU
  // contention: this promise's `maxMs` timer and the test's timeout are
  // both `setTimeout`s competing for the same congested event loop), or a
  // caller juggling two concurrent streams only ever awaits one of them to
  // completion. When the socket then reports its own error, rejecting a
  // promise nobody is watching anymore is exactly what Node calls an
  // Unhandled Rejection (DOR-807). A caller that DOES await `done` still
  // sees the real rejection normally through its own attachment below —
  // this only keeps the copy nobody was watching from escaping.
  done.catch(() => {});
  return { ready, done, close: () => forceClose() };
}

/**
 * Open `GET /:id/events` once and return its frames up to `turn_end`. Used to
 * drain the durable stream after a turn was triggered (and to assert on the
 * cold snapshot).
 *
 * @param server - The file's one listening server (see {@link attachEventStream}).
 * @param sessionId - Session id for the stream path.
 * @param opts.until - The `event:` name that closes the stream, or a predicate
 *   over the raw SSE text for a stop condition no single name expresses.
 * @param opts.maxMs - Safety cap so a missing terminator can't hang the test.
 */
export function openEventStream(
  server: http.Server,
  sessionId: string,
  opts: { until?: string; maxMs?: number } = {}
): Promise<EventsResult> {
  return attachEventStream(server, sessionId, opts).done;
}

/**
 * Drive the full trigger-only round trip with the real client ordering:
 * subscribe to `/events` FIRST, wait for the cold snapshot, THEN POST to trigger
 * the turn (asserting a 202), and collect the turn's LIVE frames up to
 * `turn_end`. Returns only the live SessionEvent frames (the leading `snapshot`
 * is dropped) so callers can assert on the turn's event sequence.
 *
 * @param server - The file's one listening server (see {@link attachEventStream}).
 * @param sessionId - Target session id.
 * @param content - The user message text.
 */
export async function collectTriggeredTurn(
  server: http.Server,
  sessionId: string,
  content: string
): Promise<SseFrame[]> {
  const stream = attachEventStream(server, sessionId);
  await stream.ready;
  const post = await request(server).post(`/api/sessions/${sessionId}/messages`).send({ content });
  if (post.status !== 202) {
    stream.close();
    throw new Error(`expected 202 from trigger POST, got ${post.status}`);
  }
  const { frames } = await stream.done;
  return frames.filter((f) => f.event !== 'snapshot');
}
