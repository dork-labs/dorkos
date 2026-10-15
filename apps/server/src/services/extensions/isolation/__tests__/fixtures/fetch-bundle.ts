/**
 * The fixture extension the fetch-handler suite serves in BOTH runtimes
 * (DOR-2686 task 5.1, DOR-2861): CommonJS source, the shape the extension
 * compiler emits for a server entry, written as a `defineServer` start that
 * returns a plain `fetch` handler (no Hono: this source is evaluated as is,
 * with only `@dorkos/extension-api/server` injected).
 *
 * Its routes report what the handler saw (body, headers, the path below the
 * mount, who is asking), stream, flood with real backpressure, hang until
 * the request's signal aborts, set headers DorkOS drops, redirect, exit
 * mid-reply, and sit behind `checkPerson`.
 *
 * @module services/extensions/isolation/__tests__/fixtures/fetch-bundle
 */

/** The bundle source. */
export const FETCH_BUNDLE_SOURCE = String.raw`
'use strict';
const { defineServer, checkPerson } = require('@dorkos/extension-api/server');

const FLOOD_TOTAL = 32 * 1024 * 1024;
const FLOOD_CHUNK = 64 * 1024;
const encoder = new TextEncoder();

module.exports = defineServer(() => {
  let aborted = false;
  // How many bytes the flood's stream has been asked for: the reader pulls
  // only as fast as the connection drains, so this stays small while the
  // person's reader is paused.
  let flooded = 0;

  const json = (body, init) => Response.json(body, init);

  async function fetch(request, caller) {
    const url = new URL(request.url);
    const route = request.method + ' ' + url.pathname;
    const item = /^\/items\/([^/]+)$/.exec(url.pathname);

    if (request.method === 'GET' && item) {
      return json({
        path: url.pathname,
        params: { itemId: decodeURIComponent(item[1]) },
        query: Object.fromEntries(url.searchParams),
      });
    }

    switch (route) {
      case 'POST /echo-json': {
        const text = await request.text();
        return json({
          body: text ? JSON.parse(text) : null,
          contentType: request.headers.get('content-type'),
          contentLength: request.headers.get('content-length'),
        });
      }

      case 'POST /echo-raw':
        return new Response('got:' + (await request.text()), {
          headers: { 'content-type': 'text/plain' },
        });

      case 'GET /headers':
        return json({ headers: Object.fromEntries(request.headers), person: caller.person });

      case 'GET /sse':
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: one\n\n'));
              setTimeout(() => {
                controller.enqueue(encoder.encode('data: two\n\n'));
                controller.close();
              }, 600);
            },
          }),
          { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }
        );

      case 'GET /cookie':
        return json(
          { ok: true },
          {
            headers: {
              'set-cookie': 'stolen=1; Path=/',
              'strict-transport-security': 'max-age=1',
              'access-control-allow-origin': '*',
              'content-security-policy': 'default-src *',
              'x-ext-own': 'kept',
            },
          }
        );

      case 'GET /danger':
        return json(
          { ok: true },
          {
            headers: {
              'clear-site-data': '"cookies", "storage"',
              refresh: '0; url=https://evil.example',
              'www-authenticate': 'Basic realm="DorkOS"',
              'service-worker-allowed': '/',
              // Values DorkOS's own CORS step never sends, so a leak is visible.
              'access-control-allow-credentials': 'from-child',
              'access-control-allow-origin': 'https://evil.example',
              'cross-origin-opener-policy': 'unsafe-none',
              link: '</evil.js>; rel=preload',
              'x-dorkos-agent': 'forged',
              etag: '"v1"',
            },
          }
        );

      case 'GET /redirect':
        return new Response(null, {
          status: 302,
          headers: { location: url.searchParams.get('to') ?? '/' },
        });

      // 64 KB chunks, up to 32 MB, handed over only when the stream is pulled.
      case 'GET /flood':
        flooded = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (flooded >= FLOOD_TOTAL) {
                controller.close();
                return;
              }
              flooded += FLOOD_CHUNK;
              controller.enqueue(new Uint8Array(FLOOD_CHUNK).fill(7));
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } }
        );

      case 'GET /flooded':
        return json({ flooded });

      // Never answers; notes when the person's request goes away.
      case 'GET /hang':
        aborted = false;
        return new Promise((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            resolve(new Response(null, { status: 499 }));
          });
        });

      case 'GET /aborted':
        return json({ aborted });

      case 'GET /exit-before':
        process.exit(3);
        break;

      case 'GET /exit-after':
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('partial'));
              setTimeout(() => process.exit(3), 200);
            },
          }),
          { headers: { 'content-type': 'text/plain' } }
        );

      case 'GET /slow':
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return json({ late: true });

      case 'PUT /settings': {
        const refused = checkPerson(caller);
        if (refused) return refused;
        return json({ ok: true });
      }
    }
    return json({ error: 'no route' }, { status: 404 });
  }

  return { fetch };
});
`;
