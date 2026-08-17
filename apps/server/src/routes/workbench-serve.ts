/**
 * Workbench embedded-browser serving routes (DOR-216, DOR-1260;
 * ADR 260708-185519).
 *
 * Three routes:
 * - `POST /api/workbench/sign` — mint what the embedded browser needs to load a
 *   target (auth-gated by the app-wide session gate). A `serve` request gets a
 *   short-lived signed URL into the static route below, after its cwd is checked
 *   against the boundary. A `proxy` request opens (or reuses) a preview listener
 *   for that dev-server port and returns its bootstrap URL — a whole origin of
 *   its own, because a dev server served under a path prefix cannot resolve its
 *   own root-absolute assets. See `services/workbench-serve/preview-listener.ts`.
 * - `POST /api/workbench/probe` — report whether a loopback port has a server on
 *   it, so the browser can explain a dead port instead of framing it. Auth-gated
 *   like `/sign`, and loopback-pinned: the body carries a port and nothing else.
 * - `GET /api/workbench/serve/:token/*splat` — statically serve a local file from
 *   the token's cwd so relative assets resolve. Authorized by the signed token,
 *   NOT cookie/header auth (the browser frame is opaque-origin, credential-less),
 *   so this path is exempted from the session gate.
 *
 * Local files render in a sandbox WITHOUT `allow-same-origin` (opaque origin), so
 * untrusted local HTML can never call `/api/*` as the user. A dev-server preview
 * has its own origin and keeps `allow-same-origin`, which grants it nothing
 * against the DorkOS origin.
 *
 * @module routes/workbench-serve
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { WorkbenchProbeRequestSchema, WorkbenchSignRequestSchema } from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { getTunnelHost, parseHostname } from '../lib/trusted-origins.js';
import {
  workbenchTokenSigner,
  WorkbenchTokenError,
  PreviewPortExhaustedError,
  previewListeners,
  probeLoopbackPort,
  injectDevtoolsScript,
  PREVIEW_BOOTSTRAP_PARAM,
} from '../services/workbench-serve/index.js';

const router = Router();

/**
 * Content types for statically served workbench files, by extension. Broad
 * enough for a rendered local site (HTML + its relative assets); anything
 * unlisted is served as an opaque download so it can never be sniffed into an
 * executable type.
 */
const SERVE_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** The relative remainder captured by an Express 5 `*splat`, normalized to a POSIX path. */
function splatToPath(splat: unknown): string {
  if (Array.isArray(splat)) return splat.join('/');
  if (typeof splat === 'string') return splat;
  return '';
}

/** A single named route param (Express 5 types it as `string | string[]`). */
function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

/** Map a token-verification failure to its HTTP status (expired vs. forged/malformed). */
function tokenErrorStatus(err: WorkbenchTokenError): number {
  return err.code === 'EXPIRED' ? 401 : 403;
}

/**
 * `POST /api/workbench/sign` — mint what the embedded browser needs to load a
 * target. Auth-gated: only an authenticated caller can obtain a token, which then
 * authorizes the (gate-exempt) serve route or the preview listener. Every URL is
 * absolute and built from the host the caller actually reached, so it resolves in
 * dev (cross-origin Vite), in production, and from another device on the network.
 */
router.post('/sign', async (req, res) => {
  const parsed = WorkbenchSignRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }

  if (parsed.data.kind === 'serve') {
    const origin = `${req.protocol}://${req.get('host')}`;
    let validatedCwd: string;
    try {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    } catch (err) {
      if (err instanceof BoundaryError) {
        const status = err.code === 'NULL_BYTE' ? 400 : 403;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      logger.error('[workbench-serve] sign(serve) boundary failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
    // Normalize the initial path to a clean cwd-relative POSIX path so the URL's
    // splat is unambiguous. Reject a path that escapes the cwd up front (the
    // serve GET route re-confines with realpath as defense in depth).
    const rawPath = parsed.data.path ?? 'index.html';
    const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.join(validatedCwd, rawPath);
    const rel = path.relative(validatedCwd, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(403).json({
        error: 'Access denied: path outside directory boundary',
        code: 'OUTSIDE_BOUNDARY',
      });
    }
    const token = workbenchTokenSigner.mint({ kind: 'serve', cwd: validatedCwd });
    const encoded = rel.split(path.sep).map(encodeURIComponent).join('/');
    return res.json({ url: `${origin}/api/workbench/serve/${token}/${encoded}` });
  }

  // proxy — the port is range-validated by the schema (1–65535).
  return signPreview(req, res, parsed.data.port);
});

/**
 * Open (or reuse) the preview listener for a dev-server port and answer with the
 * bootstrap URL the browser should frame.
 *
 * The hostname is the one the caller reached DorkOS on, not a hardcoded
 * `localhost`: a cockpit at `machine.tail.ts.net` has to be sent back to
 * `machine.tail.ts.net`, or the frame would look for the preview on the phone.
 * The scheme is always `http`, because the listener speaks plain HTTP — telling
 * a caller `https` would name an address that cannot answer.
 */
async function signPreview(req: Request, res: Response, port: number) {
  const hostname = parseHostname(req.get('host')) ?? 'localhost';
  const tunnelHost = getTunnelHost();
  if (tunnelHost !== null && hostname === tunnelHost) {
    // A tunnel publishes one port, and it is not this one. Say so rather than
    // handing back an address that will quietly fail to load.
    return res.json({ url: null, unavailable: 'tunnel' as const });
  }

  let listenPort: number;
  try {
    ({ listenPort } = await previewListeners.acquire(port));
  } catch (err) {
    if (err instanceof PreviewPortExhaustedError) {
      return res.json({ url: null, unavailable: 'no-port' as const });
    }
    logger.error('[workbench-serve] preview listener failed to open', { err, port });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const token = workbenchTokenSigner.mint({ kind: 'proxy', port });
  // An IPv6 literal has to be bracketed to sit beside a port in a URL.
  const authority = hostname.includes(':') ? `[${hostname}]` : hostname;
  return res.json({
    url: `http://${authority}:${listenPort}/?${PREVIEW_BOOTSTRAP_PARAM}=${token}`,
  });
}

/**
 * `POST /api/workbench/probe` — report whether a loopback port has a server on
 * it. Auth-gated like `/sign` (only an authenticated caller can ask this machine
 * what it is running), and loopback-pinned like the proxy: the body carries a
 * port and nothing else, so there is no host to point elsewhere.
 *
 * The embedded browser calls this before framing a dev server, so a port with
 * nothing on it becomes a sentence the user can act on instead of a blank frame.
 */
router.post('/probe', async (req, res) => {
  const parsed = WorkbenchProbeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: z.flattenError(parsed.error) });
  }
  const listening = await probeLoopbackPort(parsed.data.port);
  return res.json({ listening });
});

/**
 * Serve a file from the token's cwd. The remainder path is resolved within and
 * re-validated against `cwd`, so a `..`/symlink escape is rejected (403). Content
 * type is by extension; anything unlisted is an opaque download (never sniffed).
 *
 * Registered for both the bare (`/serve/:token`, the root → index.html) and the
 * splat (`/serve/:token/*splat`) forms — the Express 5 `*splat` param does not
 * match an empty remainder.
 */
async function handleServe(req: Request, res: Response) {
  let cwd: string;
  try {
    const payload = workbenchTokenSigner.verify(param(req.params.token));
    if (payload.scope.kind !== 'serve') {
      return res.status(403).json({ error: 'Token is not a serve token', code: 'WRONG_SCOPE' });
    }
    cwd = payload.scope.cwd;
  } catch (err) {
    if (err instanceof WorkbenchTokenError) {
      return res.status(tokenErrorStatus(err)).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const relPath = splatToPath(req.params.splat) || 'index.html';
  let resolved: string;
  try {
    // Re-confine against cwd (which itself was boundary-validated at mint time):
    // realpath resolution rejects `..`/symlink escapes out of the served root.
    const target = path.join(cwd, relPath);
    resolved = await validateBoundary(target, cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      const status = err.code === 'NULL_BYTE' ? 400 : 403;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return res.status(400).json({ error: 'Invalid path', code });
    }
    logger.error('[workbench-serve] serve resolve failed', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return res.status(404).json({ error: 'Not a file', code: 'NOT_A_FILE' });
    size = stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    logger.error('[workbench-serve] serve stat failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const contentType = SERVE_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  // Defense-in-depth: the signed bearer token lives in the URL path, so never
  // let it leak to any onward navigation/subresource via the Referer header.
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Inject the DevTools capture shim into HTML only (DOR-213): read the (small)
  // document, insert the inline shim as the first <head> child, and send it with
  // a recomputed Content-Length. Every other content-type streams byte-for-byte
  // unchanged. A page whose own CSP forbids inline scripts simply refuses ours.
  if (contentType?.startsWith('text/html')) {
    let injected: string;
    try {
      injected = injectDevtoolsScript(await fs.readFile(resolved, 'utf8'));
    } catch (err) {
      logger.error('[workbench-serve] serve read/inject failed', { err, resolved });
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.setHeader('Content-Length', Buffer.byteLength(injected));
    res.end(injected);
    return;
  }

  res.setHeader('Content-Length', size);
  const stream = createReadStream(resolved);
  stream.on('error', (err) => {
    logger.error('[workbench-serve] serve stream failed', { err, resolved });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.destroy(err);
  });
  stream.pipe(res);
}

router.get('/serve/:token', handleServe);
router.get('/serve/:token/*splat', handleServe);

export default router;
