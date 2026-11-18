/**
 * The media fetch for an extension that runs in its own process (DOR-4321):
 * one real HTTP request to the child over a virtual connection, as
 * `isolated-router.ts` forwards every other request, answered as a web
 * `Response` the media route streams on.
 *
 * What crosses is less than a forwarded request: the method, the mount and
 * the ticket's path (no query), `Range` and `If-Range`, and a person verdict
 * that always says the caller is not a person (`http/media-fetch.ts`). The
 * same idle limit holds (120 s with no bytes either way), and the virtual
 * connection is closed once the reply ends, fails or the player goes away.
 *
 * @module services/extensions/isolation/isolated-media
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { NO_PERSON, type ExtensionMediaFetch } from '../http/media-fetch.js';
import { ISOLATION_LIMITS, PERSON_VERDICT_HEADER } from './ipc-protocol.js';
import type { IsolatedExtensionHost } from './isolated-host.js';

/** The request headers a media request copies; nothing else reaches the child. */
const COPIED = ['range', 'if-range'] as const;

/**
 * The reply's headers as a web `Headers`, every value kept.
 *
 * @param reply - The child's reply.
 */
function replyHeaders(reply: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}

/**
 * Build the media fetch for one isolated extension.
 *
 * @param id - The extension id: its mount is `/api/ext/<id>`.
 * @param host - The host running its process.
 * @param idleMs - Idle limit in milliseconds (tests shorten it).
 */
export function isolatedMediaFetch(
  id: string,
  host: Pick<IsolatedExtensionHost, 'openConnection'>,
  idleMs: number = ISOLATION_LIMITS.httpIdleMs
): ExtensionMediaFetch {
  const mount = `/api/ext/${id}`;
  return (subPath, headers, method, signal) =>
    new Promise<Response>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let done = false;
      const touch = (): void => {
        if (done) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('The app did not answer in time.')), idleMs);
        timer.unref();
      };
      const opened = host.openConnection(touch);
      if (!opened.ok) {
        reject(new Error('The app is not running or is busy.'));
        return;
      }
      const socket = opened.socket;
      /** End this exchange once; before the reply, `error` rejects it. */
      function finish(error?: Error): void {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        if (error) reject(error);
      }
      function onAbort(): void {
        finish(new Error('The player went away.'));
      }
      if (signal?.aborted) {
        finish(new Error('The player went away.'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const out: http.OutgoingHttpHeaders = {
        [PERSON_VERDICT_HEADER]: JSON.stringify(NO_PERSON),
        // One request per virtual connection.
        connection: 'close',
      };
      for (const name of COPIED) {
        const value = headers.get(name);
        if (value !== null) out[name] = value;
      }

      let upstream: http.ClientRequest;
      try {
        upstream = http.request({
          method,
          path: `${mount}${subPath}`,
          headers: out,
          createConnection: () => socket,
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      upstream.on('response', (reply) => {
        touch();
        reply.on('data', touch);
        // The reply ended, failed or was cancelled by the reader: the
        // connection goes with it. A rejection no longer applies once answered.
        reply.once('close', () => finish());
        reply.once('error', () => finish());
        // A status a web `Response` cannot carry reads as a failure, which the
        // media route answers 502 for anyway.
        const sent = reply.statusCode ?? 502;
        const status = sent >= 200 && sent <= 599 ? sent : 502;
        const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        if (empty) reply.resume();
        const body = empty
          ? null
          : (Readable.toWeb(reply) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers: replyHeaders(reply) }));
      });
      upstream.on('error', (err) => finish(err));
      touch();
      upstream.end();
    });
}
