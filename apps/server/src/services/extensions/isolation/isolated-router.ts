/**
 * What DorkOS answers `/api/ext/<id>` with for an isolated extension
 * (DOR-2686, spec §7): every request is forwarded as real HTTP to the
 * extension's own process over a virtual connection, and the person's
 * credentials never go with it.
 *
 * `getHandler(id)` hands this out like any extension's handler, so
 * `routes/extension-api.ts` serves it the same way. It works on the raw Node
 * request and response (`c.env.incoming`, `c.env.outgoing`), because the
 * reply streams straight through from the child.
 *
 * ## What crosses
 *
 * - **The request.** Method, the path as the route matched it (the mount,
 *   then the path below it with dot segments resolved, then the query), so
 *   `req.baseUrl`, `req.path` and `req.params` in the child match the
 *   in-process case and an absolute-form or `//host` target can't name
 *   another host there; and the headers below. A body the chain's JSON parser already read is re-encoded
 *   as JSON with a fresh `content-length`; any other body is streamed as is.
 *   Either way the app-wide 1 MB limit holds.
 * - **Headers going in.** Stripped: `cookie`, `authorization`,
 *   `proxy-authorization`, `x-api-key` (the MCP and per-user key header), every
 *   `x-dorkos-*` header (agent identity, approval tokens), and hop-by-hop
 *   headers. Added: {@link PERSON_VERDICT_HEADER}, the person bar's verdict
 *   on the real request (`assessPerson`), which `ctx.requirePerson` and a
 *   fetch handler's caller read in the child. A client-sent copy of that
 *   header is stripped with the rest, so it cannot be forged. The session
 *   cookie stays here, which matters because a cookie that left the machine
 *   works through the tunnel.
 * - **Headers coming out.** The one rule for every extension reply DorkOS
 *   sees (`http/reply-headers.ts`): content and caching headers, other `x-`
 *   headers, and a `location` only back into the extension's own mount.
 *   Everything else, `set-cookie` included, is dropped, and a sandboxing CSP
 *   is always set.
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
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { honoRequestFacts } from '../../../http/request-facts.js';
import { personVerdict } from '../inbox/extension-inbox-context.js';
import {
  firstAnswer,
  MAX_FORWARDED_BODY_BYTES,
  TOO_LARGE,
  type ExtensionHttpHandler,
} from '../http/extension-http.js';
import { outboundHeaders } from '../http/reply-headers.js';
import { ISOLATION_LIMITS, PERSON_VERDICT_HEADER } from './ipc-protocol.js';
import type { IsolatedExtensionHost } from './isolated-host.js';

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

/** Whether a request carries a body to stream. */
function hasBody(req: http.IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

/**
 * Answer with JSON on the raw response, the bytes Express's `res.json` wrote.
 *
 * @param res - The raw response.
 * @param status - The status.
 * @param body - The JSON body.
 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

/** What {@link createIsolatedHandler} needs. */
export interface IsolatedHandlerOptions {
  /** The extension's display name, for the messages a person reads. */
  displayName: string;
  /** The host running the extension's process. */
  host: Pick<IsolatedExtensionHost, 'openConnection'>;
  /** A hybrid extension's `dataProxy`, tried first. */
  proxy?: ExtensionHttpHandler | null;
  /** Idle limit in milliseconds (tests shorten it). */
  idleMs?: number;
}

/**
 * Build the handler for one isolated extension.
 *
 * @param options - See {@link IsolatedHandlerOptions}.
 */
export function createIsolatedHandler(options: IsolatedHandlerOptions): ExtensionHttpHandler {
  const { displayName: name, host } = options;
  const idleMs = options.idleMs ?? ISOLATION_LIMITS.httpIdleMs;

  const forward: ExtensionHttpHandler = ({ c, mount, subPath }) =>
    new Promise<Response>((resolve) => {
      const req = c.env.incoming;
      const res = c.env.outgoing;
      // The exchange is over once the response has closed, as for a request
      // the front door hands off: the chain's log and audit see all of it.
      res.once('close', () =>
        resolve(new Response(null, { headers: RESPONSE_ALREADY_SENT.headers }))
      );

      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_FORWARDED_BODY_BYTES) {
        sendJson(res, 413, { error: TOO_LARGE });
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
      headers[PERSON_VERDICT_HEADER] = JSON.stringify(personVerdict(honoRequestFacts(c), name));
      // One request per virtual connection.
      headers.connection = 'close';

      let payload: Buffer | null = null;
      const parsed = c.get('body');
      if (parsed !== undefined) {
        // The chain's body parser already read the stream: send what it
        // produced. JSON is re-encoded, so its length and encoding are new.
        payload = Buffer.isBuffer(parsed) ? parsed : Buffer.from(JSON.stringify(parsed));
        delete headers['transfer-encoding'];
        delete headers['content-encoding'];
        headers['content-length'] = String(payload.byteLength);
      } else if (!hasBody(req)) {
        delete headers['content-length'];
      }

      const opened = host.openConnection(touch);
      if (!opened.ok) {
        sendJson(res, 503, {
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
          else sendJson(res, answer.status, { error: answer.error });
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
          path: `${mount}${subPath}${new URL(c.req.url).search}`,
          headers,
          createConnection: () => socket,
        });
      } catch {
        finish({ status: 400, error: `${name} couldn't take that request.` });
        return;
      }

      upstream.on('response', (reply) => {
        touch();
        res.statusCode = reply.statusCode ?? 502;
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
      upstream.on('error', () =>
        finish({ status: 503, error: `${name} stopped while answering.` })
      );

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
            finish({ status: 413, error: TOO_LARGE });
          }
        });
        req.pipe(upstream);
      } else {
        upstream.end();
      }
    });

  return firstAnswer(options.proxy, forward);
}
