import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

// Exercises the real serve/proxy routes end-to-end: real boundary confinement,
// the real token signer (so token auth is the actual security boundary), and a
// real localhost upstream for the proxy. Config/tunnel are stubbed so createApp
// builds without a live server.

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
import { workbenchTokenSigner } from '../../services/workbench-serve/index.js';

let root: string;
let outside: string;
const app = createApp();

beforeAll(async () => {
  // realpath so the served root matches the canonical boundary (macOS symlinks
  // /var → /private/var); the sign route canonicalizes cwd the same way at mint.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-serve-')));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>hello preview</h1>', 'utf8');
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
    const forged = `${token.slice(0, -2)}xx`;
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

describe('ALL /api/workbench/proxy/:token/*', () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      // A dev server that would refuse framing — the proxy must strip these.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html');
      // Echo the received URL so tests can assert exactly what was forwarded.
      res.end(`<h1>dev server</h1><pre>${req.url}</pre>`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(() => {
    upstream.close();
  });

  it('relays the dev server and strips X-Frame-Options / frame-ancestors so it can be framed', async () => {
    const token = workbenchTokenSigner.mint({ kind: 'proxy', port: upstreamPort });
    const res = await request(app).get(`/api/workbench/proxy/${token}/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('dev server');
    expect(res.headers['x-frame-options']).toBeUndefined();
    // CSP survives but with frame-ancestors removed.
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).not.toContain('frame-ancestors');
    // The bearer token in the URL must not leak to the framed page's onward nav.
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('keeps a literal `?` in a path segment out of the upstream query (no unintended split)', async () => {
    const token = workbenchTokenSigner.mint({ kind: 'proxy', port: upstreamPort });
    // `foo%3Fbar.js` is a filename containing `?`; it must reach the upstream as
    // an encoded path segment, not split into a query.
    const res = await request(app).get(`/api/workbench/proxy/${token}/foo%3Fbar.js`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/foo%3Fbar.js');
  });

  it('returns 502 when nothing is listening on the target port (no arbitrary-host reach)', async () => {
    // A closed loopback port — the proxy is loopback-pinned, so this is the only
    // failure mode; there is no way to point it at a non-loopback host.
    const token = workbenchTokenSigner.mint({ kind: 'proxy', port: 59999 });
    const res = await request(app).get(`/api/workbench/proxy/${token}/`);
    expect(res.status).toBe(502);
  });
});
