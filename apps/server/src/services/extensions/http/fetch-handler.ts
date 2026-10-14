/**
 * An extension's `fetch` handler behind its mount (DOR-2687): the
 * web-standard shape beside the Express router (`@dorkos/extension-api`'s
 * `server-entry.ts`).
 *
 * The handler gets a `Request` for the path below the mount, so an app
 * written for its own server against the web `Request` and `Response` (a Hono
 * app, say) serves unchanged: a request to `/api/ext/my-ext/items?page=2`
 * arrives as `http://<host>/items?page=2`. The URL is always on the app's own
 * origin, the `Host` the chain vetted, whatever the request target named.
 * Everything else is the request as sent, behind the whole `/api` chain:
 *
 * - **Headers** as the caller sent them, as an in-process router sees them.
 * - **The body.** A JSON body the chain already parsed is sent again as JSON,
 *   so `request.json()` works; any other body is the caller's bytes. A body
 *   over 1 MB is answered `413` before the handler runs, as for an extension
 *   in its own process.
 * - **Leaving.** The request's `signal` aborts when the caller goes away.
 *
 * The handler's second argument says who is asking (`ExtensionCaller`): the
 * person bar's verdict on this request, the same verdict an extension in its
 * own process gets, so `requirePerson()` and `checkPerson` behave the same in
 * both.
 *
 * The answer's status and body are sent as they are. Its headers pass the one
 * reply-header rule (`reply-headers.ts`), so a fetch handler can't set a
 * cookie, a redirect out of its mount, or anything else DorkOS's origin would
 * act on. A handler that throws, or answers with something that is not a
 * `Response`, gets the chain's error answer, as a router that throws does.
 *
 * @module services/extensions/http/fetch-handler
 */
import type { IncomingMessage } from 'node:http';
import type { ExtensionCaller, ExtensionFetchHandler } from '@dorkos/extension-api/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../../http/api-chain.js';
import { honoRequestFacts } from '../../../http/request-facts.js';
import { personVerdict } from '../inbox/extension-inbox-context.js';
import { outboundWebHeaders } from './reply-headers.js';
import {
  MAX_FORWARDED_BODY_BYTES,
  TOO_LARGE,
  type ExtensionHttpHandler,
} from './extension-http.js';

/** Methods whose request carries no body. */
const BODILESS = new Set(['GET', 'HEAD']);

/** What {@link readBody} gives back for a body over the limit. */
const OVER_LIMIT = Symbol('over limit');

/**
 * The URL the handler is given: the path below the mount and the query, on
 * the origin the `Host` header names. Built field by field, never by resolving
 * the path against the origin, so a path such as `//evil.com/x` stays a path.
 *
 * @param c - The request's context.
 * @param subPath - The path below the mount.
 */
function extensionUrl(c: Context<ApiEnv>, subPath: string): URL {
  const sent = new URL(c.req.url);
  // An absolute-form target (`GET http://elsewhere/…`) names a host of its
  // own in the URL; the `Host` header is the one the chain's host guard read.
  const host = c.env.incoming.headers.host;
  let url = new URL(sent.origin);
  if (host) {
    try {
      url = new URL(`${sent.protocol}//${host}`);
    } catch {
      // Not a host a URL can carry: keep the URL's own origin.
    }
  }
  url.pathname = subPath;
  url.search = sent.search;
  url.hash = '';
  return url;
}

/**
 * Read a body the chain did not parse, up to {@link MAX_FORWARDED_BODY_BYTES}.
 *
 * @param incoming - The caller's request stream.
 * @returns The bytes, `null` for none, or {@link OVER_LIMIT}.
 */
function readBody(incoming: IncomingMessage): Promise<Buffer | null | typeof OVER_LIMIT> {
  const declared = Number(incoming.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_FORWARDED_BODY_BYTES) {
    // Drain it unread, so the 413 is not cut off by a reset.
    incoming.resume();
    return Promise.resolve(OVER_LIMIT);
  }
  if (incoming.readableEnded) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let seen = 0;
    const stop = (): void => {
      incoming.off('data', onData);
      incoming.off('end', onEnd);
      incoming.off('error', onError);
      incoming.off('close', onClose);
    };
    function onData(chunk: Buffer): void {
      seen += chunk.byteLength;
      if (seen > MAX_FORWARDED_BODY_BYTES) {
        // Stop keeping it, and let the rest drain unread: destroying the
        // request would cut the 413 off on its way out.
        stop();
        incoming.resume();
        resolve(OVER_LIMIT);
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      stop();
      resolve(seen === 0 ? null : Buffer.concat(chunks));
    }
    function onError(error: Error): void {
      stop();
      reject(error);
    }
    function onClose(): void {
      onError(new Error('The request closed before its body arrived.'));
    }
    incoming.on('data', onData);
    incoming.on('end', onEnd);
    incoming.on('error', onError);
    incoming.on('close', onClose);
  });
}

/**
 * The `Request` an extension's fetch handler is given: the path below its
 * mount, the caller's headers, and the body.
 *
 * @param c - The request's context.
 * @param subPath - The path below the mount.
 * @returns The request, or `null` when its body is over the limit.
 */
export async function extensionRequest(
  c: Context<ApiEnv>,
  subPath: string
): Promise<Request | null> {
  // Read from the raw Node pair and Hono's request, never `c.req.raw.body` or
  // `.signal`: either builds the platform `Request` from the incoming stream,
  // which the chain's JSON parser may already have read to the end.
  const { incoming, outgoing } = c.env;
  const headers = new Headers(c.req.raw.headers);
  const parsed = c.get('body');
  let body: BodyInit | null = null;
  if (parsed !== undefined) {
    body = JSON.stringify(parsed);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
  } else if (!BODILESS.has(c.req.method)) {
    const read = await readBody(incoming);
    if (read === OVER_LIMIT) return null;
    body = read as BodyInit | null;
  }
  const left = new AbortController();
  outgoing.once('close', () => {
    if (!outgoing.writableFinished) left.abort();
  });
  return new Request(extensionUrl(c, subPath), {
    method: c.req.method,
    headers,
    body,
    signal: left.signal,
  });
}

/**
 * Serve an extension's `fetch` handler behind its mount. It answers every
 * request it is asked; it never passes one on.
 *
 * @param name - The extension's name: what the person bar's refusals say,
 *   and the error when it answers wrongly.
 * @param fetch - The handler `register()` returned.
 */
export function createFetchHandler(
  name: string,
  fetch: ExtensionFetchHandler
): ExtensionHttpHandler {
  return async ({ c, mount, subPath }) => {
    const request = await extensionRequest(c, subPath);
    // The rest of that body is never read, so the connection cannot carry
    // another request: it closes once this answer is out.
    if (!request) return c.json({ error: TOO_LARGE }, 413, { connection: 'close' });
    const caller: ExtensionCaller = Object.freeze({
      person: Object.freeze(personVerdict(honoRequestFacts(c), name)),
    });
    const answer: unknown = await fetch(request, caller);
    if (!(answer instanceof Response)) {
      throw new Error(`${name} answered with something that is not a Response.`);
    }
    // A new answer with only the headers the rule lets through, which the
    // chain can still add its own (CORS) to.
    return new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers: outboundWebHeaders(answer.headers, mount),
    });
  };
}
