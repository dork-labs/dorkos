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

/** Options for {@link collectDurableEvents} and {@link collectDurableEventsAt}. */
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
  /**
   * Sent as the `?cwd=<dir>` query param — the session's working directory. Lets
   * boundary tests drive the stream with an agent-home cwd (e.g.
   * `{dorkHome}/agents/dorkbot`) to prove it is not rejected.
   */
  cwd?: string;
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
      frames.push({ ...(id !== undefined ? { id } : {}), event, data: JSON.parse(line.slice(6)) });
      id = undefined;
      event = '';
    }
  }
  return frames;
}

/** Build the `/events` request path for a session, with the optional resume cursor and cwd. */
function eventsPath(sessionId: string, opts: { after?: number; cwd?: string }): string {
  const params = new URLSearchParams();
  if (opts.after !== undefined) params.set('after', String(opts.after));
  if (opts.cwd !== undefined) params.set('cwd', opts.cwd);
  const query = params.toString();
  return `/api/sessions/${sessionId}/events${query ? `?${query}` : ''}`;
}

/**
 * Connect to an already-listening `/events` endpoint and collect SSE frames,
 * resolving when `until` is satisfied (the connection is destroyed and the
 * frames so far returned) or when the server ends the stream. The single
 * implementation of the frame parser + `until` loop shared by both
 * {@link collectDurableEvents} (which owns the server) and
 * {@link collectDurableEventsAt} (which targets an existing port).
 *
 * @param reqOptions - Node `http.request` options (host, port, path, headers).
 * @param until - Stop predicate over the frames collected so far.
 * @returns The collected frames, raw text, headers, and status.
 */
function collectSseFrames(
  reqOptions: http.RequestOptions,
  until: ((frames: SseFrame[]) => boolean) | undefined
): Promise<DurableEventsResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(reqOptions, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      const finish = (): void => {
        if (settled) return;
        settled = true;
        req.destroy();
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
        if (until?.(parseFrames(raw))) finish();
      });
      res.on('end', finish);
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
  });
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
 * @returns The collected frames, raw text, headers, and status.
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
      collectSseFrames(
        {
          host: '127.0.0.1',
          port,
          path: eventsPath(sessionId, opts),
          method: 'GET',
          headers: opts.lastEventId !== undefined ? { 'Last-Event-ID': opts.lastEventId } : {},
        },
        opts.until
      )
        .then((result) => {
          server.close();
          resolve(result);
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/**
 * The URL-targeting sibling of {@link collectDurableEvents}: open the durable
 * `/events` stream against an ALREADY-LISTENING server (a base URL from a
 * separate process or an `app.listen(0)` the caller owns) and collect SSE
 * frames with the same parser and `until` loop. This is the collector the eval
 * harness uses for both the in-process (own `baseUrl`) and the credentialed
 * child-process (a foreign port) modes — `collectDurableEvents` cannot serve
 * the latter because it CREATES the server.
 *
 * @param baseUrl - Base URL of the running server (e.g. `http://127.0.0.1:53511`).
 * @param sessionId - Target session id.
 * @param opts - Stop condition and resume signals; see {@link CollectDurableEventsOptions}.
 * @returns The collected frames, raw text, headers, and status.
 */
export function collectDurableEventsAt(
  baseUrl: string,
  sessionId: string,
  opts: CollectDurableEventsOptions = {}
): Promise<DurableEventsResult> {
  const url = new URL(baseUrl);
  return collectSseFrames(
    {
      host: url.hostname,
      port: Number(url.port),
      path: eventsPath(sessionId, opts),
      method: 'GET',
      headers: opts.lastEventId !== undefined ? { 'Last-Event-ID': opts.lastEventId } : {},
    },
    opts.until
  );
}
