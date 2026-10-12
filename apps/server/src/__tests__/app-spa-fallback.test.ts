import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

// Singletons the chain reads per request (the host guard, the session gate):
// mock them so the test never touches ~/.dork.
vi.mock('../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), getAll: vi.fn().mockReturnValue({}) },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

import { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { createApiApp } from '../http/api-chain.js';
import { createClientFiles } from '../http/client-files.js';
import { frontDoorListener } from '../http/front-door.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/**
 * Guards serving the built client: what the chain answers outside `/api` when
 * no route claims a path (`http/unclaimed.ts`, `http/client-files.ts`).
 * Regression coverage first written for the Express 5 migration (DOR-171), when
 * a bare `app.get('*')` and `res.sendFile` with an absolute path each silently
 * broke client-side deep links in a packaged CLI.
 */
describe('the client build behind the chain', () => {
  let dist: string;

  /** A bundle named the way Vite names them: content hash in the filename. */
  const HASHED_ASSET = 'index-a1b2c3d4.js';

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-spa-fallback-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    // A Vite-shaped dist: content-hashed bundles under assets/, unhashed
    // static files at the root.
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', HASHED_ASSET), 'console.log(1);');
    fs.writeFileSync(path.join(dist, 'favicon.ico'), 'icon');
    const app = createApiApp({
      admission: new MainRequestAdmission(),
      clientFiles: createClientFiles(dist),
    });
    app.get('/api/ping', (c) => c.json({ ok: true }));
    fixtureTarget.mount(frontDoorListener(app));
  });

  afterAll(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('serves index.html for a client-side deep link', async () => {
    const res = await request(fixtureServer).get('/agents/deep/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('serves index.html for a deep link carrying a query string', async () => {
    const res = await request(fixtureServer).get('/session?id=abc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('serves a HEAD deep link, as GET would be served', async () => {
    const res = await request(fixtureServer).head('/agents/deep/route');
    expect(res.status).toBe(200);
  });

  it('returns the JSON API 404 for unknown /api routes, not the SPA shell', async () => {
    const res = await request(fixtureServer).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('API_NOT_FOUND');
  });

  it('does not serve the SPA shell for non-GET requests', async () => {
    const res = await request(fixtureServer).post('/agents/deep/route');
    expect(res.status).toBe(404);
  });

  /**
   * A missing hashed bundle under /assets/ must 404, not fall through to the
   * SPA shell (DOR-1474). Before this, a stale reference to a bundle a new
   * build no longer ships presented as a silent blank window instead of a
   * diagnosable 404 -- the exact way the v0.63.0 class of bug hid.
   */
  describe('missing assets 404 instead of falling back to the SPA shell', () => {
    it('404s a missing hashed bundle instead of serving the SPA shell', async () => {
      const res = await request(fixtureServer).get('/assets/nope-abc123.js');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('id="root"');
      expect(res.headers['cache-control']).not.toBe('no-store');
    });

    it('still serves an existing hashed bundle as 200 immutable', async () => {
      const res = await request(fixtureServer).get(`/assets/${HASHED_ASSET}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('404s a HEAD request for a missing hashed bundle', async () => {
      const res = await request(fixtureServer).head('/assets/nope-abc123.js');
      expect(res.status).toBe(404);
    });

    it('still serves a genuine deep client route as 200 index.html no-store', async () => {
      const res = await request(fixtureServer).get('/agents/deep/route');
      expect(res.status).toBe(200);
      expect(res.text).toContain('id="root"');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('404s the exact /assets/ directory (no matching index file within it)', async () => {
      const res = await request(fixtureServer).get('/assets/');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('id="root"');
    });
  });

  /**
   * Cache hygiene (DOR-1452). A shell held in a browser's HTTP cache across an
   * app update names hashed bundles the new build no longer ships — the blank
   * window every Electron shell eventually hits. `no-store` on the shell and
   * `immutable` on the hashed bundles is what makes that impossible, and both
   * were the `max-age=0` default before.
   */
  describe('cache headers', () => {
    it('never stores the shell served at /', async () => {
      const res = await request(fixtureServer).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never stores the shell requested by name', async () => {
      const res = await request(fixtureServer).get('/index.html');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never stores the shell served through the deep-link fallback', async () => {
      const res = await request(fixtureServer).get('/agents/deep/route');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('caches a content-hashed bundle for a year, immutably', async () => {
      const res = await request(fixtureServer).get(`/assets/${HASHED_ASSET}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('leaves unhashed root files (favicon) on the revalidating default', async () => {
      const res = await request(fixtureServer).get('/favicon.ico');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).not.toContain('no-store');
      expect(res.headers['cache-control']).not.toContain('immutable');
    });
  });

  /**
   * Content-Security-Policy on the shell (DOR-560). The app renders
   * agent-authored markdown, gen-UI widgets and marketplace card content on its
   * own privileged origin, and before this header nothing stopped injected
   * content from loading and running a script off the internet there.
   *
   * The shell document is the only response whose policy governs the app, so
   * these tests pin it at BOTH the doors a person can arrive through — the
   * static file and the deep-link fallback — and pin the two directives whose
   * absence would make the header decorative.
   *
   * **This file is the only coverage the policy has.** The browser suite cannot
   * see it: `apps/e2e` loads the app from the Vite dev server, which serves its
   * own shell with no header at all (see the note on the Vite leg in
   * `apps/e2e/playwright.config.ts`). So the exact header is asserted whole
   * below rather than by substring — a reviewer changing a directive has to
   * change a string that reads like the thing they are shipping, and the diff
   * shows the policy, not a fragment of it.
   */
  describe('content security policy', () => {
    /**
     * The policy exactly as it goes out, byte for byte.
     *
     * Every directive here was verified against the real bundle in Chromium
     * (DOR-560), and two are here because the obvious stricter value BREAKS a
     * shipped surface, which no substring assertion would have recorded:
     * `object-src` is not `'none'` because the PDF canvas is an `<object>`, and
     * `connect-src` includes `http:` because the canvas asks the browser
     * whether it can reach a plain-http dev server before framing one.
     */
    const EXPECTED_CSP = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https: http:",
      "media-src 'self' data: blob: https: http:",
      "object-src 'self' data: https: http:",
      "frame-src 'self' https: http:",
      "worker-src 'self' blob:",
      "connect-src 'self' data: https: http:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    /** The directives of the shell's CSP, as a name -> value lookup. */
    async function policyFor(url: string): Promise<Record<string, string>> {
      const res = await request(fixtureServer).get(url);
      expect(res.status).toBe(200);
      const header = res.headers['content-security-policy'];
      expect(header, `no CSP on ${url}`).toBeTruthy();
      return Object.fromEntries(
        header.split(';').map((directive: string) => {
          const [name, ...values] = directive.trim().split(/\s+/);
          return [name, values.join(' ')];
        })
      );
    }

    it('serves the whole policy with the shell at /', async () => {
      const res = await request(fixtureServer).get('/');
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP);
    });

    it('serves the whole policy with the shell requested by name', async () => {
      const res = await request(fixtureServer).get('/index.html');
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP);
    });

    it('serves the whole policy with the shell behind a deep link', async () => {
      // A deep link is served by different machinery from `/` (the `send`
      // fallback, not the static hit), so the header has to be set in
      // two places and is asserted in both.
      const res = await request(fixtureServer).get('/agents/deep/route');
      expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP);
    });

    it('allows no remote script host and no eval', async () => {
      const scriptSrc = (await policyFor('/'))['script-src'];
      // 'unsafe-inline' stays (the boot sentinel is inline, and a srcdoc frame
      // inherits this policy) — what must never appear is a way to run code
      // that arrived from somewhere else.
      expect(scriptSrc).not.toContain('http');
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(scriptSrc.split(/\s+/)).toContain("'self'");
    });

    it('lets the browser probe a plain-http dev server before the canvas frames it', async () => {
      // `canvas/lib/probe-direct.ts` fetches `http://localhost:<port>` and
      // reads a rejection as "nothing is listening". A CSP rejection is
      // indistinguishable from a refused connection there, so dropping `http:`
      // makes every healthy dev server report as unreachable and never framed —
      // measured in Chromium, and the reason this assertion is a behavior, not
      // a directive.
      const connectSrc = (await policyFor('/'))['connect-src'].split(/\s+/);
      expect(connectSrc).toContain("'self'");
      expect(connectSrc).toContain('http:');
      expect(connectSrc).toContain('https:');
    });

    it('lets nobody frame the app', async () => {
      expect((await policyFor('/'))['frame-ancestors']).toBe("'none'");
    });

    it('keeps the surfaces that render remote content working', async () => {
      const policy = await policyFor('/');
      // Agent markdown embeds remote images; the canvas browser frames pages;
      // the 3D decoders and confetti build workers from blob URLs. Each of
      // these was verified against the real bundle — a policy that broke them
      // would be reverted, so it is pinned here rather than rediscovered.
      expect(policy['img-src']).toContain('https:');
      expect(policy['frame-src']).toContain('https:');
      expect(policy['worker-src']).toContain('blob:');
      expect(policy['style-src']).toContain('https://fonts.googleapis.com');
      // The PDF canvas is an `<object>` pointing at a served file, a remote
      // URL, or a data: URI — `object-src 'none'`, which every hardening guide
      // reaches for first, would show a blank pane instead of the document.
      expect(policy['object-src']).toContain("'self'");
      expect(policy['object-src']).toContain('data:');
    });

    it('does not put the shell policy on hashed bundles', async () => {
      // The policy belongs to the document, not its assets — a second copy on
      // every bundle is bytes that enforce nothing.
      const res = await request(fixtureServer).get(`/assets/${HASHED_ASSET}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  });
});
