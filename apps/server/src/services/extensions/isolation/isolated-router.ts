/**
 * The router DorkOS mounts at `/api/ext/<id>` for an isolated extension
 * (DOR-2686, spec §7): every request is forwarded as real HTTP to the
 * extension's own process over a virtual connection, and the person's
 * credentials never go with it.
 *
 * `getRouter(id)` hands this out like any extension router, so
 * `middleware/extension-routes.ts` and its mount are unchanged.
 *
 * ## What crosses
 *
 * - **The request.** Method, `req.originalUrl` (so `req.baseUrl`, `req.path`
 *   and `req.params` in the child match the in-process case), and the
 *   headers below. A body `express.json` already read is re-encoded as JSON
 *   with a fresh `content-length`; any other body is streamed as is. Either
 *   way the app-wide 1 MB limit holds.
 * - **Headers going in.** Stripped: `cookie`, `authorization`,
 *   `proxy-authorization`, `x-api-key` (the MCP and per-user key header), every
 *   `x-dorkos-*` header (agent identity, approval tokens), and hop-by-hop
 *   headers. Added: {@link PERSON_VERDICT_HEADER}, the person bar's verdict
 *   on the real request (`assessPerson`), which `ctx.requirePerson` reads in
 *   the child. A client-sent copy of that header is stripped with the rest,
 *   so it cannot be forged. The session cookie stays here, which matters
 *   because a cookie that left the machine works through the tunnel.
 * - **Headers coming out.** An allowlist ({@link OUTBOUND_ALLOWED}): content
 *   and caching headers, other `x-` headers, and a `location` only back into
 *   the extension's own mount. Everything else, `set-cookie` and
 *   `clear-site-data` included, is dropped. Always set:
 *   `content-security-policy: sandbox; default-src 'none'` and
 *   `x-content-type-options: nosniff`, so a reply opened as a page cannot
 *   run script on DorkOS's origin.
 *
 * ## When it goes wrong
 *
 * - 120 s with no bytes either way: 504 "<Name> didn't answer in time." before
 *   the reply's headers, cut off after them. A server-sent-events stream that
 *   is quiet that long is cut off too; authors send a heartbeat.
 * - A person reading slower than the child writes: the virtual connection
 *   pauses the child (`virtual-socket.ts`), and a child that ignores the
 *   pause is cut off once 4 MB sits unread.
 * - The person's request goes away: the virtual connection is dropped, and
 *   the child's request sees its socket close.
 * - The child exits before the reply's headers: 503 "<Name> stopped while
 *   answering."; after them, the reply is cut off.
 *
 * A hybrid extension's `dataProxy` routes are host code with a host-declared
 * base URL; they stay here and are tried first, as in-process.
 *
 * @module services/extensions/isolation/isolated-router
 */
import http from 'node:http';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { assessPerson } from '../../../routes/extensions-person-bar.js';
import { requirePersonCopy } from '../inbox/extension-inbox-context.js';
import { ISOLATION_LIMITS, PERSON_VERDICT_HEADER, type PersonVerdict } from './ipc-protocol.js';
import type { IsolatedExtensionHost } from './isolated-host.js';

/** The largest request body forwarded: the app-wide JSON limit (`app.ts`). */
export const MAX_FORWARDED_BODY_BYTES = 1024 * 1024;

/** Headers that describe one hop, never forwarded either way (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

/** Request headers that carry the person's or an agent's credentials. */
const INBOUND_STRIPPED = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  // Not a credential, but it names the person's browser tab to DorkOS, and
  // nothing in an extension needs it.
  'x-client-id',
]);

/**
 * The reply headers an extension may set, by exact name. Everything else is
 * dropped: an allowlist, because the dangerous ones are an open set
 * (`set-cookie`, `clear-site-data` signing the person out, `refresh`,
 * `www-authenticate` raising a password prompt on DorkOS's origin,
 * `service-worker-allowed`, `strict-transport-security`, CORS and CSP
 * overrides). `location` is allowed separately, only back into the
 * extension's own mount ({@link sameMountLocation}); other `x-` headers
 * (but no `x-dorkos-`) pass, since browsers give none of them a meaning
 * that crosses the CSP set below.
 */
const OUTBOUND_ALLOWED = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'pragma',
  'etag',
  'last-modified',
  'vary',
  'retry-after',
  'date',
]);

/**
 * A `location` the reply may carry: one that, resolved against the request,
 * stays on the same origin and inside the extension's own mount. Anything
 * else (another site, another DorkOS route, `//host`) is dropped, so an
 * extension can't make DorkOS's origin an open redirect or send the person's
 * browser to a DorkOS route with their cookie.
 *
 * @param value - The `location` header.
 * @param mount - The extension's mount, `/api/ext/<id>`.
 * @returns The header to send, or `null` to drop it.
 */
export function sameMountLocation(
  value: string | string[] | undefined,
  mount: string
): string | null {
  if (typeof value !== 'string' || value.includes('\\')) return null;
  const base = new URL(`http://dorkos.invalid${mount}/`);
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (target.pathname !== mount && !target.pathname.startsWith(`${mount}/`)) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

/** Set on every reply from an isolated extension. */
export const OUTBOUND_FORCED: Readonly<Record<string, string>> = {
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
};

/**
 * The names a `Connection` header lists, which are hop-by-hop too.
 *
 * @param value - The `Connection` header.
 */
function connectionListed(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * The request headers forwarded to the child: everything but credentials,
 * DorkOS's own headers and hop-by-hop headers.
 *
 * @param headers - The incoming request's headers (lower-case names).
 */
export function inboundHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = connectionListed(headers.connection);
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || listed.has(key) || INBOUND_STRIPPED.has(key)) continue;
    if (key.startsWith('x-dorkos-')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The reply headers passed back to the person: only {@link OUTBOUND_ALLOWED}
 * names, other `x-` headers, and a `location` inside the extension's mount,
 * plus the forced pair.
 *
 * @param headers - The child's reply headers (lower-case names).
 * @param mount - The extension's mount, `/api/ext/<id>`.
 */
export function outboundHeaders(
  headers: http.IncomingHttpHeaders,
  mount: string
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (key === 'location') {
      const location = sameMountLocation(value, mount);
      if (location !== null) out.location = location;
      continue;
    }
    const xHeader = key.startsWith('x-') && !key.startsWith('x-dorkos-');
    if (OUTBOUND_ALLOWED.has(key) || xHeader) out[key] = value;
  }
  return { ...out, ...OUTBOUND_FORCED };
}

/**
 * The person bar's verdict on this request, worded for this extension.
 *
 * @param req - The real request (with its cookie and headers).
 * @param res - Its response (read for the signed-in user; never written).
 * @param displayName - The extension's name.
 */
export function personVerdict(req: Request, res: Response, displayName: string): PersonVerdict {
  const refusal = assessPerson(req, res, requirePersonCopy(displayName));
  return refusal ? { ok: false, status: refusal.status, body: refusal.body } : { ok: true };
}

/** Whether a request carries a body to stream. */
function hasBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

/** What {@link createIsolatedRouter} needs. */
export interface IsolatedRouterOptions {
  /** The extension's display name, for the messages a person reads. */
  displayName: string;
  /** The host running the extension's process. */
  host: Pick<IsolatedExtensionHost, 'openConnection'>;
  /** A hybrid extension's `dataProxy` routes, tried first. */
  proxyRouter?: RequestHandler | null;
  /** Idle limit in milliseconds (tests shorten it). */
  idleMs?: number;
}

/**
 * Build the router for one isolated extension.
 *
 * @param options - See {@link IsolatedRouterOptions}.
 */
export function createIsolatedRouter(options: IsolatedRouterOptions): Router {
  const { displayName: name, host } = options;
  const idleMs = options.idleMs ?? ISOLATION_LIMITS.httpIdleMs;

  const forward: RequestHandler = (req, res) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_FORWARDED_BODY_BYTES) {
      res.status(413).json({ error: 'That request is too large.' });
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const touch = (): void => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onIdle, idleMs);
      timer.unref();
    };

    // Everything that reads the request is decided before a connection is
    // opened, so nothing that throws here can leave one counted and open.
    const headers = inboundHeaders(req.headers);
    headers[PERSON_VERDICT_HEADER] = JSON.stringify(personVerdict(req, res, name));
    // One request per virtual connection.
    headers.connection = 'close';

    let payload: Buffer | null = null;
    if (req.body !== undefined) {
      // A body parser already read the stream: send what it produced. JSON
      // is re-encoded, so its length and encoding are new.
      payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      delete headers['transfer-encoding'];
      delete headers['content-encoding'];
      headers['content-length'] = String(payload.byteLength);
    } else if (!hasBody(req)) {
      delete headers['content-length'];
    }
    const mount = req.baseUrl;

    const opened = host.openConnection(touch);
    if (!opened.ok) {
      res.status(503).json({
        error:
          opened.reason === 'busy'
            ? `${name} is busy. Try again in a moment.`
            : `${name} isn't running right now.`,
      });
      return;
    }
    const socket = opened.socket;

    /**
     * End this exchange once: answer with an error when nothing was sent yet
     * (or cut the reply off when something was), cut it off outright, or end
     * quietly when the person already left. The virtual connection goes in
     * every case.
     */
    const finish = (answer: { status: number; error: string } | 'cut' | 'quiet'): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (answer === 'cut') {
        res.destroy();
      } else if (answer !== 'quiet') {
        if (res.headersSent) res.destroy();
        else res.status(answer.status).json({ error: answer.error });
      }
      socket.destroy();
    };
    function onIdle(): void {
      finish({ status: 504, error: `${name} didn't answer in time.` });
    }

    let upstream: http.ClientRequest;
    try {
      upstream = http.request({
        method: req.method,
        path: req.originalUrl,
        headers,
        createConnection: () => socket,
      });
    } catch {
      finish({ status: 400, error: `${name} couldn't take that request.` });
      return;
    }

    upstream.on('response', (reply) => {
      touch();
      res.status(reply.statusCode ?? 502);
      for (const [key, value] of Object.entries(outboundHeaders(reply.headers, mount))) {
        res.setHeader(key, value);
      }
      // Headers go now, so a streamed reply (server-sent events) starts
      // arriving before its first chunk.
      res.flushHeaders();
      reply.on('data', touch);
      reply.on('error', () => finish('cut'));
      reply.on('aborted', () => finish('cut'));
      reply.pipe(res);
    });
    upstream.on('error', () => finish({ status: 503, error: `${name} stopped while answering.` }));

    // The whole reply went out: the exchange is over.
    res.on('finish', () => finish('quiet'));
    // The person's side went away before the reply finished: drop the
    // connection, so the child's request sees its socket close.
    res.on('close', () => {
      if (!res.writableFinished) finish('quiet');
    });

    touch();
    if (payload) {
      upstream.end(payload);
    } else if (hasBody(req)) {
      let seen = 0;
      req.on('data', (chunk: Buffer) => {
        seen += chunk.byteLength;
        if (seen > MAX_FORWARDED_BODY_BYTES) {
          req.unpipe(upstream);
          finish({ status: 413, error: 'That request is too large.' });
        }
      });
      req.pipe(upstream);
    } else {
      upstream.end();
    }
  };

  const router = Router();
  if (options.proxyRouter) router.use(options.proxyRouter);
  router.use(forward);
  return router;
}
