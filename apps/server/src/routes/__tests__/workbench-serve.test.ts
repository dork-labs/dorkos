import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

// Exercises the real serve + sign routes end-to-end: real boundary confinement,
// the real token signer (so token auth is the actual security boundary), and a
// real preview listener in front of a real localhost upstream. Config/tunnel are
// stubbed so createApp builds without a live server. What the listener itself
// does with a request is covered in services/workbench-serve/__tests__.

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { initBoundary } from '../../lib/boundary.js';
import { WORKBENCH } from '../../config/constants.js';
import {
  previewListeners,
  PreviewPortExhaustedError,
  workbenchTokenSigner,
} from '../../services/workbench-serve/index.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';

let root: string;
let outside: string;
const app = createApp();

beforeAll(async () => {
  // realpath so the served root matches the canonical boundary (macOS symlinks
  // /var → /private/var); the sign route canonicalizes cwd the same way at mint.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-serve-')));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>hello preview</h1>', 'utf8');
  await fs.writeFile(
    path.join(root, 'page.html'),
    '<html><head><title>t</title></head><body><h1>hi</h1></body></html>',
    'utf8'
  );
  await fs.writeFile(path.join(root, 'style.css'), 'body{color:red}', 'utf8');
  // A file OUTSIDE the served root, to prove the path-escape rejection is real.
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-outside-')));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  await initBoundary(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('POST /api/workbench/sign', () => {
  it('mints a serve URL for a cwd within the boundary, and that URL serves the file', async () => {
    const sign = await request(app).post('/api/workbench/sign').send({ kind: 'serve', cwd: root });
    expect(sign.status).toBe(200);
    expect(sign.body.url).toContain('/api/workbench/serve/');
    expect(sign.body.url).toContain('/index.html');

    // Follow the minted URL (strip origin — supertest targets the same app).
    const servePath = sign.body.url.slice(sign.body.url.indexOf('/api/'));
    const served = await request(app).get(servePath);
    expect(served.status).toBe(200);
    expect(served.text).toContain('hello preview');
    // Served content must never be sniffed into an executable type.
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects minting a serve URL for a cwd outside the boundary (403)', async () => {
    const res = await request(app)
      .post('/api/workbench/sign')
      .send({ kind: 'serve', cwd: outside });
    expect(res.status).toBe(403);
  });

  it('rejects a proxy port outside the valid range — no arbitrary target (400)', async () => {
    const res = await request(app).post('/api/workbench/sign').send({ kind: 'proxy', port: 70000 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/workbench/probe', () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(() => {
    upstream.close();
  });

  it('reports a port with a server on it as listening', async () => {
    const res = await request(app).post('/api/workbench/probe').send({ port: upstreamPort });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ listening: true });
  });

  it('reports a port with nothing on it as not listening', async () => {
    // Bind a port, read it, then release it: nothing else can have claimed it in
    // the microseconds since, so "closed" is a fact rather than a guess.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const res = await request(app).post('/api/workbench/probe').send({ port: deadPort });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ listening: false });
  });

  it('finds a server bound only to IPv6 loopback', async () => {
    // A dev server that binds "localhost" can land on ::1 alone, and the browser
    // resolves "localhost" for itself when it loads the frame. Probing IPv4 only
    // would call such a server dead while the frame renders it perfectly.
    const v6 = http.createServer((_req, res) => res.end('ok'));
    const bound = await new Promise<boolean>((resolve) => {
      v6.once('error', () => resolve(false));
      v6.listen(0, '::1', () => resolve(true));
    });
    if (!bound) {
      // A runner with no IPv6 loopback cannot answer this question either way.
      // Skipping is honest; passing on a listener that never bound would not be.
      v6.close();
      return;
    }
    try {
      const port = (v6.address() as AddressInfo).port;
      const res = await request(app).post('/api/workbench/probe').send({ port });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ listening: true });
    } finally {
      await new Promise<void>((resolve) => v6.close(() => resolve()));
    }
  });

  it('rejects a port outside the valid range (400)', async () => {
    expect((await request(app).post('/api/workbench/probe').send({ port: 70000 })).status).toBe(
      400
    );
    expect((await request(app).post('/api/workbench/probe').send({ port: 0 })).status).toBe(400);
    expect((await request(app).post('/api/workbench/probe').send({})).status).toBe(400);
  });
});

describe('GET /api/workbench/serve/:token/*', () => {
  const validToken = () => workbenchTokenSigner.mint({ kind: 'serve', cwd: root });

  it('serves a relative asset within the cwd, with no-referrer so the token URL cannot leak', async () => {
    const res = await request(app).get(`/api/workbench/serve/${validToken()}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.text).toContain('color:red');
    // The signed bearer token lives in the URL path — never leak it via Referer.
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects an EXPIRED token with 401', async () => {
    // Mint with a past `now` so exp is already behind the real clock.
    const expired = workbenchTokenSigner.mint(
      { kind: 'serve', cwd: root },
      Date.now() - WORKBENCH.SIGNED_URL_TTL_MS - 1000
    );
    const res = await request(app).get(`/api/workbench/serve/${expired}/index.html`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('EXPIRED');
  });

  it('rejects a FORGED token (tampered signature) with 403', async () => {
    const token = validToken();
    const dot = token.indexOf('.');
    // Tamper the FIRST signature character, never the last. A 32-byte HMAC
    // base64url-encodes to 43 characters — 258 bits of alphabet for 256 bits of
    // data — so the final character carries 2 bits that decoding throws away,
    // and two different trailing characters can decode to the SAME signature.
    // Tampering there leaves a measured ~6% flake where the "forged" token is
    // byte-identical to the valid one and the route correctly returns 200.
    // Every bit of the first character is significant, so this always differs.
    const sigHead = token[dot + 1];
    const forged = `${token.slice(0, dot + 1)}${sigHead === 'A' ? 'B' : 'A'}${token.slice(dot + 2)}`;
    expect(forged).not.toBe(token);
    const res = await request(app).get(`/api/workbench/serve/${forged}/index.html`);
    expect(res.status).toBe(403);
  });

  it('rejects a path escape (../) out of the cwd even with a valid token (403)', async () => {
    // Encode the traversal so it survives URL routing and lands in the splat.
    const escape = encodeURIComponent(`../${path.basename(outside)}/secret.txt`);
    const res = await request(app).get(`/api/workbench/serve/${validToken()}/${escape}`);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('TOP SECRET');
  });

  it('rejects a proxy-scoped token on the serve route (403 wrong scope)', async () => {
    const proxyToken = workbenchTokenSigner.mint({ kind: 'proxy', port: 5173 });
    const res = await request(app).get(`/api/workbench/serve/${proxyToken}/index.html`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/workbench/serve — DevTools shim injection (DOR-213)', () => {
  const validToken = () => workbenchTokenSigner.mint({ kind: 'serve', cwd: root });

  it('injects the shim as the first <head> child of an HTML file, with a recomputed Content-Length', async () => {
    const res = await request(app).get(`/api/workbench/serve/${validToken()}/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toMatch(/<head><script>/);
    expect(res.text).toContain('__dorkosDevtools');
    expect(res.text).toContain('<h1>hi</h1>');
    // Length must reflect the injected body, not the on-disk file size.
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.text));
  });

  it('leaves a non-HTML asset byte-for-byte unchanged (no shim, no length change)', async () => {
    const res = await request(app).get(`/api/workbench/serve/${validToken()}/style.css`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('body{color:red}');
    expect(res.text).not.toContain('__dorkosDevtools');
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength('body{color:red}'));
  });
});

describe('POST /api/workbench/sign — dev-server preview', () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end('<h1>dev server</h1>'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await previewListeners.close();
    upstream.close();
  });

  afterEach(() => {
    tunnelManager.status.url = null;
    vi.restoreAllMocks();
  });

  it('answers with a preview origin on the host the caller reached, not the API port', async () => {
    const res = await request(app)
      .post('/api/workbench/sign')
      // Not `localhost`, so a hardcoded hostname would show up here. (A LAN or
      // Tailscale name would too, but the app's host guard rejects those before
      // the route sees them — that guard is tested in `trusted-origins`.)
      .set('Host', '127.0.0.1:4242')
      .send({ kind: 'proxy', port: upstreamPort });

    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    // The hostname the caller used, kept: telling a phone to load `localhost`
    // would point it at the phone.
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).not.toBe('4242');
    expect(url.searchParams.get('__dorkos_preview')).toBeTruthy();
  });

  it('reuses one listener for one dev server', async () => {
    const first = await request(app)
      .post('/api/workbench/sign')
      .send({ kind: 'proxy', port: upstreamPort });
    const second = await request(app)
      .post('/api/workbench/sign')
      .send({ kind: 'proxy', port: upstreamPort });

    expect(new URL(second.body.url).port).toBe(new URL(first.body.url).port);
  });

  it('says previews are unavailable through a tunnel instead of naming an unreachable port', async () => {
    tunnelManager.status.url = 'https://demo.ngrok.app';

    const res = await request(app)
      .post('/api/workbench/sign')
      .set('Host', 'demo.ngrok.app')
      .send({ kind: 'proxy', port: upstreamPort });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null, unavailable: 'tunnel' });
  });

  it('says so when every preview port in the configured range is taken', async () => {
    vi.spyOn(previewListeners, 'acquire').mockRejectedValue(
      new PreviewPortExhaustedError({ from: 4243, to: 4243 })
    );

    const res = await request(app)
      .post('/api/workbench/sign')
      .send({ kind: 'proxy', port: upstreamPort });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null, unavailable: 'no-port' });
  });
});
