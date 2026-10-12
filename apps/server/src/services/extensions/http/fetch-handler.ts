/**
 * An extension's `fetch` handler behind its mount (DOR-2687): the
 * web-standard shape beside the Express router (`@dorkos/extension-api`'s
 * `server-entry.ts`).
 *
 * The handler gets a `Request` for the path below the mount, so an app
 * written for its own server (a Hono app, a Bun or Deno handler) serves
 * unchanged: a request to `/api/ext/my-ext/items?page=2` arrives as
 * `http://<host>/items?page=2`. Everything else is the request as sent,
 * behind the whole `/api` chain:
 *
 * - **Headers** as the caller sent them, as an in-process router sees them.
 * - **The body.** A JSON body the chain already parsed is sent again as JSON,
 *   so `request.json()` works; any other body is the caller's stream, unread.
 * - **Leaving.** The request's `signal` aborts when the caller goes away.
 *
 * Whatever the handler answers is sent as it is. A handler that throws, or
 * answers with something that is not a `Response`, gets the chain's error
 * answer, as a router that throws does.
 *
 * @module services/extensions/http/fetch-handler
 */
import { Readable } from 'node:stream';
import type { ExtensionFetchHandler } from '@dorkos/extension-api/server';
import type { Context } from 'hono';
import type { ApiEnv } from '../../../http/api-chain.js';
import type { ExtensionHttpHandler } from './extension-http.js';

/** Methods whose request carries no body. */
const BODILESS = new Set(['GET', 'HEAD']);

/**
 * The `Request` an extension's fetch handler is given: the path below its
 * mount, the caller's headers, and the body.
 *
 * @param c - The request's context.
 * @param subPath - The path below the mount, as sent.
 */
export function extensionRequest(c: Context<ApiEnv>, subPath: string): Request {
  // Read from the raw Node pair and Hono's request, never `c.req.raw.body` or
  // `.signal`: either builds the platform `Request` from the incoming stream,
  // which the chain's JSON parser may already have read to the end.
  const { incoming, outgoing } = c.env;
  const sent = new URL(c.req.url);
  const url = new URL(`${subPath}${sent.search}`, sent.origin);
  const headers = new Headers(c.req.raw.headers);
  const parsed = c.get('body');
  let body: BodyInit | null = null;
  if (parsed !== undefined) {
    body = JSON.stringify(parsed);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
  } else if (!BODILESS.has(c.req.method)) {
    body = Readable.toWeb(incoming) as unknown as BodyInit;
  }
  const left = new AbortController();
  outgoing.once('close', () => {
    if (!outgoing.writableFinished) left.abort();
  });
  return new Request(url, {
    method: c.req.method,
    headers,
    body,
    signal: left.signal,
    // A streamed body needs this in Node; it changes nothing for a string.
    duplex: 'half',
  } as RequestInit);
}

/**
 * Serve an extension's `fetch` handler behind its mount. It answers every
 * request it is asked; it never passes one on.
 *
 * @param name - The extension's name, for the error when it answers wrongly.
 * @param fetch - The handler `register()` returned.
 */
export function createFetchHandler(
  name: string,
  fetch: ExtensionFetchHandler
): ExtensionHttpHandler {
  return async ({ c, subPath }) => {
    const answer: unknown = await fetch(extensionRequest(c, subPath));
    if (!(answer instanceof Response)) {
      throw new Error(`${name} answered with something that is not a Response.`);
    }
    // A copy, so the chain can still add its own headers (CORS) to an answer
    // whose headers are locked, as a `fetch()` result's are.
    return new Response(answer.body, answer);
  };
}
