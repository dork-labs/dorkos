/**
 * @vitest-environment node
 *
 * The app page carries a fresh page stamp only when a browser navigates to it
 * (DOR-5026): never for a script's fetch, an iframe or a HEAD, and never from
 * a cache.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { readPageStamp, sessionFingerprint } from '../../services/extensions/step-up/page-stamp.js';
import { createClientFiles } from '../client-files.js';

const target = swappableServer();
const server = target.server;
let dist: string;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-stamp-shell-'));
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    '<!doctype html><html><head><title>DorkOS</title></head><body><div id="root"></div></body></html>'
  );
  const files = createClientFiles(dist);
  target.mount((req, res) =>
    files(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
});

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

/** The stamp in a page, or null. */
function stampIn(html: string): string | null {
  return /<meta name="dorkos-page-stamp" content="([^"]+)">/.exec(html)?.[1] ?? null;
}

describe('the app page’s stamp', () => {
  it.each(['/', '/index.html', '/session?session=x'])(
    'is fresh on each navigation to %s, never stored',
    async (url) => {
      const first = await request(server).get(url).set(NAVIGATE);
      const second = await request(server).get(url).set(NAVIGATE);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['content-security-policy']).toBeTruthy();
      expect(first.headers.etag).toBeUndefined();
      const a = stampIn(first.text);
      const b = stampIn(second.text);
      expect(a).not.toBeNull();
      expect(a).not.toBe(b);
      expect(readPageStamp(a ?? undefined)).not.toBeNull();
      expect(first.text).toContain('<div id="root"></div>');
    }
  );

  it('names the sign-in the page went out under', async () => {
    const cookie = 'better-auth.session_token=made-up-a';
    const res = await request(server).get('/').set(NAVIGATE).set('Cookie', cookie);
    expect(readPageStamp(stampIn(res.text) ?? undefined)?.session).toBe(sessionFingerprint(cookie));
  });

  it('is written for a browser that sends no Sec-Fetch headers', async () => {
    expect(stampIn((await request(server).get('/')).text)).not.toBeNull();
  });

  it.each([
    ['a script’s fetch', { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
    ['a same-origin fetch', { 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' }],
    ['an iframe', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }],
  ])('is never written for %s, which still gets the page, unstored', async (_label, headers) => {
    for (const url of ['/', '/session']) {
      const res = await request(server).get(url).set(headers);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stampIn(res.text)).toBeNull();
    }
  });

  it('is never written for a HEAD: the file goes out as it is on disk', async () => {
    const res = await request(server).head('/').set(NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Number(res.headers['content-length'])).toBe(
      fs.statSync(path.join(dist, 'index.html')).size
    );
  });

  it.each(['//index.html', '/./index.html', '/INDEX.HTML'])(
    'is written for the shell however its path is spelled: %s',
    async (url) => {
      const res = await request(server).get(url).set(NAVIGATE);
      expect(res.status).toBe(200);
      expect(stampIn(res.text)).not.toBeNull();
      expect(res.headers['content-security-policy']).toBeTruthy();
    }
  );
});
