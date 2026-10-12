/**
 * The answer to a request no route claims: the last step of the chain.
 *
 * - **Under `/api`**, the API 404 (`{ error, code: 'API_NOT_FOUND' }`), so a
 *   client asking for a route this server does not have is told so in JSON,
 *   never handed the app.
 * - **Anywhere else, with a client build**, the app itself: its files, the
 *   bundle 404 and the deep-link fallback (`http/client-files.ts`), which
 *   answer GET and HEAD only.
 * - **Anything else** (no build, or a method the app does not answer), a plain
 *   404 page naming the method and path. It is the page Express's
 *   `finalhandler` wrote, byte for byte, with the same locked-down headers,
 *   because a person who mistypes a URL while running from source reads it,
 *   and `__tests__/contract/unclaimed-paths.contract.test.ts` pins it.
 *
 * The chain has already run by the time this answers: CORS, `nosniff`, the
 * body limits and the session gate all hold for these paths as for any route.
 *
 * @module http/unclaimed
 */
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context, NotFoundHandler } from 'hono';
import type { ClientFilesHandler } from './client-files.js';
import { underMount } from './request-body.js';

/** The `/api` 404 body. */
const API_NOT_FOUND_BODY = { error: 'Not found', code: 'API_NOT_FOUND' } as const;

/**
 * Characters a URL may carry as they are; everything else, and a `%` that does
 * not start an escape, is percent-encoded. The rule of the `encodeurl` package,
 * which `finalhandler` runs the path through.
 */
const ENCODE_CHARS =
  /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g;

/** A lone surrogate, which `encodeURI` refuses; replaced as `encodeurl` does. */
const UNMATCHED_SURROGATE =
  /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g;

/** Escape the five characters HTML gives meaning to. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The path a request named, as sent and without its query: what the page shows. */
function requestedPath(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * The 404 page for a request nothing answers outside `/api`.
 *
 * @param method - The request method.
 * @param url - The request URL as sent.
 * @returns The response; a HEAD gets its headers and no body.
 */
function cannotAnswer(method: string, url: string): Response {
  const target = requestedPath(url)
    .replace(UNMATCHED_SURROGATE, '$1�$2')
    .replace(ENCODE_CHARS, encodeURI);
  const page =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n' +
    `</head>\n<body>\n<pre>${escapeHtml(`Cannot ${method} ${target}`)}</pre>\n</body>\n</html>\n`;
  return new Response(method === 'HEAD' ? null : page, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(page)),
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Hand a request to the client files, and settle once they have answered it,
 * or with the 404 page when they pass it on.
 */
function serveClientFiles(
  clientFiles: ClientFilesHandler,
  c: Context<{ Bindings: HttpBindings }>
): Promise<Response> {
  const { incoming, outgoing } = c.env;
  return new Promise((resolve, reject) => {
    let settled = false;
    const sent = (): void => {
      if (settled) return;
      settled = true;
      // A fresh marker each time: the shared one has mutable headers.
      resolve(new Response(null, { headers: RESPONSE_ALREADY_SENT.headers }));
    };
    outgoing.once('finish', sent);
    outgoing.once('close', sent);
    clientFiles(incoming, outgoing, (error) => {
      if (settled) return;
      settled = true;
      outgoing.off('finish', sent);
      outgoing.off('close', sent);
      if (error) reject(error instanceof Error ? error : new Error('', { cause: error }));
      else resolve(cannotAnswer(incoming.method ?? c.req.method, incoming.url ?? c.req.path));
    });
  });
}

/**
 * Build the chain's not-found handler.
 *
 * @param clientFiles - The client build's handler, when this server serves one
 *   (production). Without it, every page is the 404 page.
 * @returns The handler, for `app.notFound`.
 */
export function answerUnclaimed<E extends { Bindings: HttpBindings }>(
  clientFiles?: ClientFilesHandler
): NotFoundHandler<E> {
  return (c) => {
    if (underMount(c.req.path, '/api')) return c.json(API_NOT_FOUND_BODY, 404);
    if (clientFiles)
      return serveClientFiles(clientFiles, c as unknown as Context<{ Bindings: HttpBindings }>);
    const { incoming } = c.env;
    return cannotAnswer(incoming.method ?? c.req.method, incoming.url ?? c.req.path);
  };
}
