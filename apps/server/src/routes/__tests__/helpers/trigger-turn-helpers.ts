/**
 * Test helpers for the trigger-only message POST + durable `/events` stream
 * (ADR-0264). They model the new client contract: POST to trigger a turn, then
 * read the turn back over `GET /:id/events` — the single delivery path.
 *
 * @module routes/__tests__/helpers/trigger-turn-helpers
 */
import http from 'node:http';
import request from 'supertest';
import type { Express } from 'express';

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
interface EventStreamHandle {
  /** Resolves once the connection is open and the cold snapshot frame arrived. */
  ready: Promise<void>;
  /** Resolves when the terminator is seen / the stream ends / `maxMs` elapses. */
  done: Promise<EventsResult>;
  /** Force-close (used by callers that don't expect a terminator). */
  close(): void;
}

/**
 * Attach to `GET /:id/events` and stream frames into a buffer, resolving `done`
 * when the `until` event appears (or the stream ends / `maxMs` elapses). The
 * `ready` promise resolves once the cold `snapshot` frame has been received so
 * callers can trigger a turn only after the live subscription exists — the
 * subscribe-first ordering the real client uses (so it cannot miss `turn_start`).
 */
function attachEventStream(
  app: Express,
  sessionId: string,
  opts: { until?: string; maxMs?: number } = {}
): EventStreamHandle {
  const until = opts.until ?? 'turn_end';
  const maxMs = opts.maxMs ?? 4000;
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  let forceClose: () => void = () => {};
  const done = new Promise<EventsResult>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      let raw = '';
      let settled = false;
      const finish = (status: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        server.close();
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
            if (raw.includes(`event: ${until}`)) finish(200);
          });
          res.on('end', () => finish(200));
        }
      );
      const timer = setTimeout(() => finish(200), maxMs);
      req.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(new Error('events request errored'));
        }
      });
      req.end();
    });
  });
  return { ready, done, close: () => forceClose() };
}

/**
 * Open `GET /:id/events` once and return its frames up to `turn_end`. Used to
 * drain the durable stream after a turn was triggered (and to assert on the
 * cold snapshot).
 *
 * @param app - The Express app under test.
 * @param sessionId - Session id for the stream path.
 * @param opts.until - The `event:` name that closes the stream.
 * @param opts.maxMs - Safety cap so a missing terminator can't hang the test.
 */
export function openEventStream(
  app: Express,
  sessionId: string,
  opts: { until?: string; maxMs?: number } = {}
): Promise<EventsResult> {
  return attachEventStream(app, sessionId, opts).done;
}

/**
 * Drive the full trigger-only round trip with the real client ordering:
 * subscribe to `/events` FIRST, wait for the cold snapshot, THEN POST to trigger
 * the turn (asserting a 202), and collect the turn's LIVE frames up to
 * `turn_end`. Returns only the live SessionEvent frames (the leading `snapshot`
 * is dropped) so callers can assert on the turn's event sequence.
 *
 * @param app - The Express app under test.
 * @param sessionId - Target session id.
 * @param content - The user message text.
 */
export async function collectTriggeredTurn(
  app: Express,
  sessionId: string,
  content: string
): Promise<SseFrame[]> {
  const stream = attachEventStream(app, sessionId);
  await stream.ready;
  const post = await request(app).post(`/api/sessions/${sessionId}/messages`).send({ content });
  if (post.status !== 202) {
    stream.close();
    throw new Error(`expected 202 from trigger POST, got ${post.status}`);
  }
  const { frames } = await stream.done;
  return frames.filter((f) => f.event !== 'snapshot');
}
