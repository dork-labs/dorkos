/**
 * Video for an app's frame (DOR-4321, Security 2026-11-18): the ticket mint
 * and the route a frame's `<video>` loads.
 *
 * - `POST /api/extensions/:id/media-tickets { path }` — asked by the person's
 *   window for its app's `api.mediaUrl(path)`, the same window-only bar as the
 *   caller-token mint (`extension-caller-token.ts`). Answers
 *   `{ url: '/api/extensions/media/<ticket>' }`.
 * - `GET|HEAD /api/extensions/media/:ticket` — outside the session gate, since
 *   the frame is an opaque origin and carries no cookie; the ticket is the
 *   capability (`services/extensions/http/media-tickets.ts`). It asks the
 *   app's own route for the ticket's path, with only `Range` and `If-Range`
 *   and a caller that is never a person, and streams the answer through.
 *
 * The host decides the reply, never the app: only `200`, `206` and `416`
 * pass, a success must be MP4 or WebM, only the headers a player needs
 * cross, and a fixed set of protective headers is always set. No redirect is
 * ever sent.
 *
 * @module routes/extension-media
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ExtensionManifest } from '@dorkos/extension-api';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { corsAllowsOrigin } from '../http/cors-policy.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { isNotAWindow } from './extension-caller-token.js';
import { SAFE_EXT_ID } from './extensions.js';
import { EXTENSION_ID_HEADER } from './extension-write-binding.js';
import type { ExtensionMediaFetch } from '../services/extensions/http/media-fetch.js';
import {
  MEDIA_URL_PREFIX,
  mintMediaTicket,
  normalizeMediaPath,
  resolveMediaTicket,
} from '../services/extensions/http/media-tickets.js';

/** What the media routes read about each app. */
export interface ExtensionMediaDeps {
  /** The app's manifest, or `undefined` when it is not installed. */
  manifest(id: string): ExtensionManifest | undefined;
  /** How to ask the running app for a video, or `null` when it cannot answer one. */
  mediaFetch(id: string): ExtensionMediaFetch | null;
}

/** The types a video reply may have; the host writes the one it matched. */
const MEDIA_VIDEO_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);

/** The statuses an app's reply may pass with; anything else is answered `502`. */
const PASSED_STATUSES = new Set([200, 206, 416]);

/** The reply headers a player needs, the only ones that cross from the app. */
const PASSED_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

/** The request headers the app is given; nothing else of the request reaches it. */
const COPIED_HEADERS = ['range', 'if-range'];

/** Set on every answer here, whatever the app sent. */
const MEDIA_FORCED_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Content-Disposition': 'inline',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  // The frame that plays it is an opaque origin.
  'Cross-Origin-Resource-Policy': 'cross-origin',
});

/** One answer for an unknown and an expired ticket, so neither tells them apart. */
const MEDIA_GONE = { error: 'This video link has expired. Open the app again.' };

const MintBodySchema = z.object({ path: z.string().max(4000) });

/** An answer with the forced headers and no body. */
function bare(status: number): Response {
  return new Response(null, { status, headers: MEDIA_FORCED_HEADERS });
}

/** A JSON answer with the forced headers. */
function json(c: Context<ApiEnv>, status: 400 | 403 | 404 | 405, body: object): Response {
  for (const [name, value] of Object.entries(MEDIA_FORCED_HEADERS)) c.header(name, value);
  return c.json(body, status);
}

/**
 * The answer the frame's player gets for the app's reply, under the host's
 * rules (see the module doc). The app's body is streamed, never read here.
 *
 * @param answer - The app's own reply.
 * @param method - `HEAD` sends the headers only.
 */
function mediaReply(answer: Response, method: 'GET' | 'HEAD'): Response {
  const refuse = (status: number): Response => {
    void answer.body?.cancel().catch(() => undefined);
    return bare(status);
  };
  if (!PASSED_STATUSES.has(answer.status)) return refuse(502);
  const headers = new Headers(MEDIA_FORCED_HEADERS);
  for (const name of PASSED_HEADERS) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // A 416 says which range exists; it carries nothing to play or sniff.
  if (answer.status === 416) {
    void answer.body?.cancel().catch(() => undefined);
    headers.delete('content-length');
    return new Response(null, { status: 416, headers });
  }
  const type = (answer.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!MEDIA_VIDEO_TYPES.has(type)) return refuse(415);
  // The encoding header never crosses, so an encoded body would reach the player as noise.
  const encoding = (answer.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return refuse(502);
  headers.set('Content-Type', type);
  if (method === 'HEAD') {
    void answer.body?.cancel().catch(() => undefined);
    return new Response(null, { status: answer.status, headers });
  }
  return new Response(answer.body, { status: answer.status, headers });
}

/**
 * The ticket mint and the media route, for `app.route('/api/extensions', …)`
 * AFTER the extensions routes (`extensions.ts`): mounted later, its
 * `/media/:ticket` never shadows a route of an app that is called `media`.
 *
 * @param deps - DorkOS's records of each app.
 * @returns The routes.
 */
export function createExtensionMediaRoutes(deps: ExtensionMediaDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/:id/media-tickets', (c) => {
    const id = c.req.param('id');
    if (!SAFE_EXT_ID.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const facts = honoRequestFacts(c);
    // A window's own fetch always names its page; a page elsewhere, or an
    // opaque (`null`) one, never mints with the person's cookie.
    const origin = c.req.header('origin');
    if (origin === undefined || origin === 'null' || !corsAllowsOrigin(facts)) {
      return c.json({ error: 'Only a DorkOS window can ask for this.' }, 403);
    }
    if (isNotAWindow(facts) || !clearsTheAgentBar(facts)) {
      return c.json({ error: 'Only a person’s DorkOS window can ask for this.' }, 403);
    }
    const stamp = facts.headers[EXTENSION_ID_HEADER];
    if (stamp !== undefined && stamp !== id) {
      return c.json({ error: 'An app can only ask for its own videos.' }, 403);
    }
    const manifest = deps.manifest(id);
    const running = deps.mediaFetch(id);
    if (!manifest || manifest.clientApiVersion !== 2 || !manifest.capabilities?.http || !running) {
      return c.json({ error: 'That app is not running, or cannot stream video.' }, 404);
    }
    const body = MintBodySchema.safeParse(readJsonBody(c));
    const subPath = body.success ? normalizeMediaPath(body.data.path) : null;
    if (subPath === null) return c.json({ error: 'Use a path inside this app.' }, 400);
    c.header('Cache-Control', 'no-store');
    return c.json({ url: `${MEDIA_URL_PREFIX}${mintMediaTicket(id, subPath, running)}` }, 201);
  });

  router.all('/media/:ticket', async (c) => {
    const method = c.req.method === 'GET' || c.req.method === 'HEAD' ? c.req.method : null;
    if (method === null) {
      c.header('Allow', 'GET, HEAD');
      return json(c, 405, { error: 'A video link can only be played.' });
    }
    // The ticket alone decides; any query string is ignored.
    const target = resolveMediaTicket(c.req.param('ticket'));
    const fetchVideo = target ? deps.mediaFetch(target.extensionId) : null;
    // Only from the instance it was minted for: a reload or update since ends it.
    if (!target || !fetchVideo || fetchVideo !== target.instance) return json(c, 404, MEDIA_GONE);
    const headers = new Headers();
    for (const name of COPIED_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    const left = new AbortController();
    const { outgoing } = c.env;
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) left.abort();
    });
    let answer: Response;
    try {
      answer = await fetchVideo(target.subPath, headers, method, left.signal);
    } catch {
      return bare(502);
    }
    return mediaReply(answer, method);
  });
  return router;
}
