/**
 * The fixture extension the router suite serves in BOTH runtimes (DOR-2686
 * task 5.1): CommonJS source, exactly what the extension compiler emits for a
 * server entry. Its routes report what the extension saw (body, headers,
 * `req.baseUrl`/`req.params`), stream, hang, set headers DorkOS strips, exit
 * mid-reply, and sit behind `ctx.requirePerson`.
 *
 * @module services/extensions/isolation/__tests__/fixtures/router-bundle
 */

/** The bundle source. */
export const ROUTER_BUNDLE_SOURCE = String.raw`
'use strict';
let aborted = false;

module.exports = function register(router, ctx) {
  router.post('/echo-json', (req, res) => {
    res.json({
      body: req.body === undefined ? null : req.body,
      contentType: req.headers['content-type'] || null,
      contentLength: req.headers['content-length'] || null,
    });
  });

  router.post('/echo-raw', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.type('text/plain').send('got:' + Buffer.concat(chunks).toString('utf8')));
  });

  router.get('/items/:itemId', (req, res) => {
    res.json({ params: req.params, baseUrl: req.baseUrl, path: req.path, query: req.query });
  });

  router.get('/headers', (req, res) => res.json(req.headers));

  router.get('/sse', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => {
      res.write('data: two\n\n');
      res.end();
    }, 600);
  });

  router.get('/cookie', (req, res) => {
    res.setHeader('set-cookie', 'stolen=1; Path=/');
    res.setHeader('strict-transport-security', 'max-age=1');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-security-policy', "default-src *");
    res.setHeader('x-ext-own', 'kept');
    res.json({ ok: true });
  });

  router.get('/danger', (req, res) => {
    res.setHeader('clear-site-data', '"cookies", "storage"');
    res.setHeader('refresh', '0; url=https://evil.example');
    res.setHeader('www-authenticate', 'Basic realm="DorkOS"');
    res.setHeader('service-worker-allowed', '/');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('cross-origin-opener-policy', 'unsafe-none');
    res.setHeader('link', '</evil.js>; rel=preload');
    res.setHeader('x-dorkos-agent', 'forged');
    res.setHeader('etag', '"v1"');
    res.json({ ok: true });
  });

  router.get('/redirect', (req, res) => {
    res.redirect(302, String(req.query.to));
  });

  // Writes 64 KB chunks as fast as backpressure lets it, up to 32 MB, and
  // counts what it managed to write.
  let flooded = 0;
  router.get('/flood', (req, res) => {
    flooded = 0;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 7);
    const pump = () => {
      while (flooded < 32 * 1024 * 1024) {
        flooded += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  router.get('/flooded', (req, res) => res.json({ flooded }));

  router.get('/hang', (req, res) => {
    aborted = false;
    res.on('close', () => {
      if (!res.writableFinished) aborted = true;
    });
  });

  router.get('/aborted', (req, res) => res.json({ aborted }));

  router.get('/exit-before', () => {
    process.exit(3);
  });

  router.get('/exit-after', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    setTimeout(() => process.exit(3), 200);
  });

  router.get('/slow', (req, res) => {
    setTimeout(() => res.json({ late: true }), 5000);
  });

  router.put('/settings', ctx.requirePerson, (req, res) => res.json({ ok: true }));
};
`;
