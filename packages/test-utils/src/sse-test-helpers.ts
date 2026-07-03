import http from 'node:http';
import type { Express } from 'express';

/** A single SSE frame parsed off the wire, including its optional `id:` line. */
export interface SseFrame {
  /** Value of the `id:` line preceding this frame's `data:`, when present. */
  id?: string;
  /** The `event:` field naming the frame type (e.g. `snapshot`, `text_delta`). */
  event: string;
  /** The JSON-parsed `data:` payload. */
  data: unknown;
}

/** One collected `GET /api/sessions/:id/events` connection. */
export interface DurableEventsResult {
  /** Frames parsed off the wire, in delivery order. */
  frames: SseFrame[];
  /** The raw SSE wire text as received. */
  raw: string;
  /** Response headers (e.g. `x-accel-buffering`). */
  headers: http.IncomingHttpHeaders;
  /** HTTP status code of the response. */
  status: number;
}

/** Options for {@link collectDurableEvents}. */
export interface CollectDurableEventsOptions {
  /**
   * Stop condition: once satisfied the connection is destroyed and the
   * collected frames resolve. The durable `/events` stream never ends on its
   * own against a real projector, so live-stream tests must provide this.
   * Omit it to collect until the server ends the stream (finite mocked
   * `subscribeSession` sources).
   */
  until?: (frames: SseFrame[]) => boolean;
  /** Sent as the `?after=<cursor>` resume query param. */
  after?: number;
  /** Sent as the `Last-Event-ID` request header (browser-reconnect resume). */
  lastEventId?: string;
}

/** Parse SSE wire text into frames, attaching the most recent `id:` to each. */
function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let id: string | undefined;
  let event = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) {
      id = line.slice(4).trim();
    } else if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ') && event) {
      frames.push({ ...(id !== undefined ? { id } : {}), event, data: JSON.parse(line.slice(6)) });
      id = undefined;
      event = '';
    }
  }
  return frames;
}

/**
 * Open the durable `GET /api/sessions/:id/events` stream (ADR-0264: turn
 * delivery rides this stream, never the trigger-only POST response) against a
 * real listening server and collect SSE frames.
 *
 * The connection resolves either when `opts.until` is satisfied (the frames
 * collected so far are returned and the connection destroyed) or when the
 * server ends the stream. Frames capture the `id:` line, so resume tests can
 * assert `<sessionId>-<epoch>-<seq>` event ids.
 *
 * @param app - Express app instance (from `createApp()` + `finalizeApp()`)
 * @param sessionId - Target session UUID
 * @param opts - Stop condition and resume signals; see {@link CollectDurableEventsOptions}
 */
export function collectDurableEvents(
  app: Express,
  sessionId: string,
  opts: CollectDurableEventsOptions = {}
): Promise<DurableEventsResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const query = opts.after !== undefined ? `?after=${opts.after}` : '';
      let settled = false;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/sessions/${sessionId}/events${query}`,
          method: 'GET',
          headers: opts.lastEventId !== undefined ? { 'Last-Event-ID': opts.lastEventId } : {},
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          const finish = (): void => {
            if (settled) return;
            settled = true;
            req.destroy();
            server.close();
            resolve({
              frames: parseFrames(raw),
              raw,
              headers: res.headers,
              status: res.statusCode ?? 0,
            });
          };
          res.on('data', (chunk: string) => {
            raw += chunk;
            // Re-parse the full buffer each chunk: SSE frames may split across
            // chunk boundaries, and full re-parsing keeps the predicate simple.
            if (opts.until?.(parseFrames(raw))) finish();
          });
          res.on('end', finish);
        }
      );
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}
