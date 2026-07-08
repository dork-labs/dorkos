/**
 * Localhost reverse-proxy for the workbench embedded browser (DOR-216).
 *
 * Forwards a request to a dev server bound to `http://127.0.0.1:<port>` and
 * relays the response back, stripping the framing headers (`X-Frame-Options` and
 * any CSP `frame-ancestors`) so the page can be embedded in the sandboxed
 * browser iframe. The target host is pinned to loopback — there is no way to
 * point this at an arbitrary host, closing off SSRF. Rendered content still gets
 * an opaque origin client-side (ADR 260708-185519), so stripping framing headers
 * never grants the page access to `/api/*`.
 *
 * v1 forwards GET/HEAD only — a dev-server *preview* is a read surface, and
 * limiting methods sidesteps re-forwarding a body Express may have already
 * consumed. (The future DevTools bridge, DOR-213, attaches here: this proxy
 * already sees all preview traffic.)
 *
 * @module services/workbench-serve/proxy
 */
import { Readable } from 'stream';
import type { Request, Response } from 'express';
import { WORKBENCH } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/** Response headers we never relay: framing guards and hop-by-hop headers. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  // Framing guards — removing them is the whole point of the proxy.
  'x-frame-options',
  // Hop-by-hop headers (RFC 7230 §6.1) — must not be forwarded.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Length is recomputed by the streaming relay; content-encoding stays intact
  // because we pass the already-decoded body through untouched via fetch.
  'content-length',
  'content-encoding',
]);

/**
 * Drop any `frame-ancestors` directive from a CSP header value so the proxied
 * page can be framed, leaving every other directive intact.
 *
 * @param csp - The upstream `Content-Security-Policy` value.
 * @returns The CSP with `frame-ancestors` removed, or `null` when nothing remains.
 */
export function stripFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d));
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Proxy a GET/HEAD request to a localhost dev server and relay the response with
 * framing headers stripped. Any non-loopback target is impossible by
 * construction (the host is hard-coded to `127.0.0.1`).
 *
 * @param port - The localhost port to proxy to (already range-validated).
 * @param targetPath - The path (with leading slash) plus query string to request.
 * @param req - The incoming Express request (method + safe request headers).
 * @param res - The Express response to relay the upstream response into.
 */
export async function proxyToLocalhost(
  port: number,
  targetPath: string,
  req: Request,
  res: Response
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({
      error: 'The workbench preview proxy forwards GET and HEAD only',
      code: 'METHOD_NOT_ALLOWED',
    });
    return;
  }

  // Host pinned to loopback — the port is the only caller-influenced value, and
  // it is validated to 1–65535 before it reaches here. No arbitrary-host SSRF.
  const target = `http://127.0.0.1:${port}${targetPath}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKBENCH.PROXY_TIMEOUT_MS);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        // Forward a minimal, safe subset; never the browser's cookies/auth for
        // the DorkOS origin (the frame is opaque-origin and sends none anyway).
        accept: req.headers.accept ?? '*/*',
        'accept-language': req.headers['accept-language'] ?? '',
        'user-agent': req.headers['user-agent'] ?? '',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const code = (err as { code?: string; name?: string }).code;
    if (code === 'ECONNREFUSED') {
      res
        .status(502)
        .json({ error: `No dev server is listening on port ${port}`, code: 'NO_UPSTREAM' });
      return;
    }
    if ((err as Error).name === 'AbortError') {
      res
        .status(504)
        .json({ error: 'The dev server did not respond in time', code: 'UPSTREAM_TIMEOUT' });
      return;
    }
    logger.error('[workbench-serve] proxy fetch failed', { err, port });
    res.status(502).json({ error: 'Proxy request failed', code: 'PROXY_FAILED' });
    return;
  }
  clearTimeout(timeout);

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) return;
    if (lower === 'content-security-policy') {
      const sanitized = stripFrameAncestors(value);
      if (sanitized) res.setHeader(key, sanitized);
      return;
    }
    res.setHeader(key, value);
  });

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
  body.on('error', (err) => {
    logger.error('[workbench-serve] proxy stream failed', { err, port });
    if (!res.headersSent) res.status(502).json({ error: 'Proxy stream failed' });
    else res.destroy(err);
  });
  body.pipe(res);
}
