/**
 * Video links for an app's frame (DOR-4321, Security 2026-11-18): the mint is
 * a person's window only, the link plays one path of one app as no person,
 * and the host, never the app, decides what the player receives.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ExtensionManifest } from '@dorkos/extension-api';
import type { ExtensionFetchHandler } from '@dorkos/extension-api/server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createExtensionMediaRoutes } from '../extension-media.js';
import {
  inProcessMediaFetch,
  type ExtensionMediaFetch,
} from '../../services/extensions/http/media-fetch.js';
import {
  MEDIA_TICKET_IDLE_MS,
  mintMediaTicket,
  resetMediaTickets,
  revokeMediaTickets,
} from '../../services/extensions/http/media-tickets.js';
import { createPersonRecordApi } from '../../services/extensions/person-record/person-record.js';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-media-'));
beforeAll(() => initConfigManager(configDir));
afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));

const manifests: Record<string, ExtensionManifest> = {
  clips: {
    id: 'clips',
    name: 'Clips',
    version: '1.0.0',
    clientApiVersion: 2,
    capabilities: { http: true },
  },
  plain: { id: 'plain', name: 'Plain', version: '1.0.0', clientApiVersion: 2 },
  legacy: {
    id: 'legacy',
    name: 'Legacy',
    version: '1.0.0',
    capabilities: { http: true },
  },
  idle: {
    id: 'idle',
    name: 'Idle',
    version: '1.0.0',
    clientApiVersion: 2,
    capabilities: { http: true },
  },
};

/** What the app's own route saw, once per request it was asked. */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  person: unknown;
  /** What `ctx.personRecord.record` said inside the route: never a person's request here. */
  recordRefused: boolean;
}
const seen: Seen[] = [];
/** What the app's route answers next. */
let reply: () => Response;

const clipsFetch: ExtensionFetchHandler = async (req, caller) => {
  let recordRefused = false;
  try {
    await createPersonRecordApi('clips').record('watched');
  } catch {
    recordRefused = true;
  }
  seen.push({
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    person: caller.person,
    recordRefused,
  });
  return reply();
};

const running: Record<string, ExtensionMediaFetch | null> = {};

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

/** The person the session gate proved, per request: a cookie session by default. */
let user: { userId: string; credential: 'cookie' | 'api-key'; sessionId?: string } | undefined;

const video = (status = 200, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4', ...headers },
  });

beforeEach(() => {
  seen.length = 0;
  resetMediaTickets();
  reply = () => video();
  running.clips = inProcessMediaFetch('Clips', clipsFetch);
  running.plain = inProcessMediaFetch('Plain', clipsFetch);
  running.legacy = inProcessMediaFetch('Legacy', clipsFetch);
  // Running with only an Express router: no fetch handler, so no media fetch.
  running.idle = inProcessMediaFetch('Idle', undefined);
  user = { userId: 'u1', credential: 'cookie', sessionId: 'sess-1' };
  fixtureTarget.mount(
    honoGroupListener(
      {
        path: '/api/extensions',
        routes: createExtensionMediaRoutes({
          manifest: (id) => manifests[id],
          mediaFetch: (id) => running[id] ?? null,
        }),
      },
      {
        before: (c, next) => {
          if (user) c.set('user', user as never);
          return next();
        },
      }
    )
  );
});

/** This server's own origin, as a DorkOS window's fetch names it. */
const ownOrigin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Ask for a link, as the window does, from `origin` (its own by default). */
const mintRequest = (id: string, body: unknown, origin: string | null = ownOrigin()) => {
  const call = request(server).post(`/api/extensions/${id}/media-tickets`);
  return (origin === null ? call : call.set('Origin', origin)).send(body as object);
};

async function mintUrl(videoPath = '/videos/intro.mp4'): Promise<string> {
  const res = await mintRequest('clips', { path: videoPath });
  expect(res.status).toBe(201);
  expect(res.body.url).toMatch(/^\/api\/extensions\/media\/[A-Za-z0-9_-]{43}$/);
  return res.body.url as string;
}

describe('POST /api/extensions/:id/media-tickets', () => {
  it('mints a link for a running frame app, and is never cached', async () => {
    const res = await mintRequest('clips', { path: '/videos/intro.mp4' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(seen).toHaveLength(0);
  });

  it('refuses an agent and an API key', async () => {
    const agent = await request(server)
      .post('/api/extensions/clips/media-tickets')
      .set('Origin', ownOrigin())
      .set('X-DorkOS-Agent', 'agent-token')
      .send({ path: '/a.mp4' });
    expect(agent.status).toBeGreaterThanOrEqual(401);
    expect(agent.body.url).toBeUndefined();
    user = { userId: 'u1', credential: 'api-key' };
    const key = await mintRequest('clips', { path: '/a.mp4' });
    expect(key.status).toBe(403);
    expect(key.body.url).toBeUndefined();
  });

  it('never mints for a page elsewhere, an opaque page, or a request naming no page', async () => {
    for (const origin of ['https://elsewhere.example', 'null', null]) {
      const res = await mintRequest('clips', { path: '/a.mp4' }, origin);
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.url).toBeUndefined();
    }
  });

  it('refuses a write stamped by another app', async () => {
    const res = await request(server)
      .post('/api/extensions/clips/media-tickets')
      .set('Origin', ownOrigin())
      .set('X-DorkOS-Extension', 'plain')
      .send({ path: '/a.mp4' });
    expect(res.status).toBe(403);
  });

  it('mints only for a frame app that declares http and can answer a video', async () => {
    // No capabilities.http, not a frame app, only an Express router, not installed.
    for (const id of ['plain', 'legacy', 'idle', 'nobody']) {
      const res = await mintRequest(id, { path: '/a.mp4' });
      expect(res.status, id).toBe(404);
      expect(typeof res.body.error).toBe('string');
    }
    // Installed but not running.
    running.clips = null;
    expect((await mintRequest('clips', { path: '/a.mp4' })).status).toBe(404);
  });

  it.each(['../other/a.mp4', '/../other/a.mp4', '/a//b.mp4', '/a%2Fb.mp4', '/a.mp4?x=1', '/a\\b'])(
    'refuses the path %j',
    async (videoPath) => {
      const res = await mintRequest('clips', { path: videoPath });
      expect(res.status).toBe(400);
      expect(res.body.url).toBeUndefined();
    }
  );

  it('refuses a body with no path', async () => {
    expect((await mintRequest('clips', {})).status).toBe(400);
    expect((await mintRequest('clips', { path: 42 })).status).toBe(400);
  });
});

describe('GET /api/extensions/media/:ticket', () => {
  it('passes a range answer through, Content-Range and all', async () => {
    const url = await mintUrl();
    reply = () => video(206, { 'Content-Range': 'bytes 0-3/1000', 'Accept-Ranges': 'bytes' });
    const res = await request(server).get(url).set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-3/1000');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(seen[0]!.headers.range).toBe('bytes=0-3');
  });

  it('passes a whole answer through', async () => {
    const url = await mintUrl();
    const res = await request(server).get(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('asks the app for the minted path below its mount, and only that', async () => {
    const url = await mintUrl('/q3 review/intro.mp4');
    await request(server).get(`${url}?path=/secrets`);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://dorkos.invalid/q3%20review/intro.mp4');
    expect(seen[0]!.method).toBe('GET');
  });

  // Security condition 1: a link never acts as the person who minted it.
  it('tells the app its caller is not a person, even when a person minted it', async () => {
    const url = await mintUrl();
    await request(server).get(url);
    expect(seen[0]!.person).toMatchObject({ ok: false, status: 403 });
    expect(seen[0]!.recordRefused).toBe(true);
  });

  it('tells the app the same with sign-in off and no session at all', async () => {
    user = undefined;
    const url = await mintUrl();
    await request(server).get(url);
    expect(seen[0]!.person).toMatchObject({ ok: false });
    expect(seen[0]!.recordRefused).toBe(true);
  });

  it('gives the app only Range and If-Range: no cookie, Origin or DorkOS header', async () => {
    const url = await mintUrl();
    await request(server)
      .get(url)
      .set('Range', 'bytes=10-')
      .set('If-Range', '"v1"')
      .set('Cookie', 'better-auth.session_token=secret')
      .set('Origin', ownOrigin())
      .set('X-DorkOS-Person', 'proof')
      .set('X-DorkOS-Extension', 'clips')
      .set('Referer', `${ownOrigin()}/x/clips`);
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['if-range', 'range']);
  });

  it('answers 502 with no body for a redirect or a failure', async () => {
    const url = await mintUrl();
    for (const answer of [
      () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } }),
      () => new Response('broken', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      () => new Response(null, { status: 204 }),
    ]) {
      reply = answer;
      const res = await request(server).get(url);
      expect(res.status).toBe(502);
      expect(res.headers.location).toBeUndefined();
      expect(res.text ?? '').toBe('');
    }
  });

  it.each(['text/html', 'image/svg+xml', 'application/octet-stream', ''])(
    'answers 415 with no body for %j',
    async (type) => {
      const url = await mintUrl();
      reply = () =>
        new Response('<script>x</script>', { headers: type ? { 'Content-Type': type } : {} });
      const res = await request(server).get(url);
      expect(res.status).toBe(415);
      expect(res.text ?? '').toBe('');
      expect(res.headers['content-type'] ?? '').not.toContain('html');
    }
  );

  it('writes the type itself from the allowed list', async () => {
    const url = await mintUrl();
    reply = () => video(200, { 'Content-Type': 'Video/WebM; codecs="vp9"' });
    const res = await request(server).get(url);
    expect(res.headers['content-type']).toBe('video/webm');
  });

  it('sets its own protective headers and lets none of the app’s other headers through', async () => {
    const url = await mintUrl();
    reply = () =>
      video(200, {
        'Set-Cookie': 'session=stolen',
        Location: '/elsewhere',
        'Content-Security-Policy': 'default-src *',
        'Cache-Control': 'public, max-age=99999',
        'Access-Control-Allow-Origin': '*',
        'X-Custom': 'x',
        ETag: '"v1"',
        'Last-Modified': 'Tue, 17 Nov 2026 10:00:00 GMT',
      });
    const res = await request(server).get(url);
    expect(res.status).toBe(200);
    // The chain adds its own `frame-ancestors 'none'` policy beside this one;
    // both apply, and the app's own policy is gone.
    expect(res.headers['content-security-policy']).toContain("sandbox; default-src 'none'");
    expect(res.headers['content-security-policy']).not.toContain('default-src *');
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'cross-origin',
      etag: '"v1"',
      'last-modified': 'Tue, 17 Nov 2026 10:00:00 GMT',
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['x-custom']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers 502 for an encoded reply, whose encoding would not cross', async () => {
    const url = await mintUrl();
    reply = () => video(200, { 'Content-Encoding': 'gzip' });
    const res = await request(server).get(url);
    expect(res.status).toBe(502);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('passes a 416 with its range and no body', async () => {
    const url = await mintUrl();
    reply = () =>
      new Response('nope', {
        status: 416,
        headers: { 'Content-Range': 'bytes */1000', 'Content-Type': 'text/html' },
      });
    const res = await request(server).get(url).set('Range', 'bytes=5000-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
    expect(res.headers['content-type'] ?? '').not.toContain('html');
    expect(res.text ?? '').toBe('');
  });

  it('answers HEAD with the headers only, and asks the app for HEAD', async () => {
    const url = await mintUrl();
    const res = await request(server).head(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe('4');
    expect(seen[0]!.method).toBe('HEAD');
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s with 405', async (method) => {
    const url = await mintUrl();
    const res = await request(server)[method](url).set('Origin', ownOrigin()).send({});
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it('answers an unknown and an expired link the same', async () => {
    const unknown = await request(server).get(`/api/extensions/media/${'a'.repeat(43)}`);
    const ticket = mintMediaTicket(
      'clips',
      '/a.mp4',
      running.clips!,
      Date.now() - MEDIA_TICKET_IDLE_MS - 1
    );
    const expired = await request(server).get(`/api/extensions/media/${ticket}`);
    expect(unknown.status).toBe(404);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
    expect(seen).toHaveLength(0);
  });

  // Security condition 3: stopping, reloading or updating the app ends its links.
  it('ends a link once its app stops', async () => {
    const url = await mintUrl();
    expect((await request(server).get(url)).status).toBe(200);
    revokeMediaTickets('clips');
    expect((await request(server).get(url)).status).toBe(404);
  });

  // A link minted while the app was stopping outlives the revoke for a moment;
  // it still never plays from the code that replaced that instance.
  it('plays a link only from the instance it was minted for', async () => {
    const url = await mintUrl();
    running.clips = inProcessMediaFetch('Clips', clipsFetch);
    expect((await request(server).get(url)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('answers 404 while the app is not running, before asking it anything', async () => {
    const url = await mintUrl();
    running.clips = null;
    expect((await request(server).get(url)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('answers 502 when the app throws', async () => {
    const url = await mintUrl();
    reply = () => {
      throw new Error('boom');
    };
    expect((await request(server).get(url)).status).toBe(502);
  });
});
