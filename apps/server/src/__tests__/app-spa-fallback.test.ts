import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// A per-run throwaway client dist so the SPA fallback has an index.html to
// serve. vi.hoisted holds a mutable ref (it runs before imports, so it can't
// build a path from `os`/`path`); the real, collision-free dir is created via
// mkdtemp in beforeAll and read lazily through the env mock's getter.
const holder = vi.hoisted(() => ({ dist: '' }));

// Force finalizeApp's production branch on (it is skipped under NODE_ENV=test,
// which is precisely why the Express 5 SPA-serving regression was invisible to
// the rest of the suite) and point CLIENT_DIST_PATH at our throwaway dist.
vi.mock('../env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: {
      ...actual.env,
      NODE_ENV: 'production',
      get CLIENT_DIST_PATH() {
        return holder.dist;
      },
    },
  };
});

// Singletons with load/first-use side effects — mock so importing app.js never
// touches ~/.dork. finalizeApp itself uses neither.
vi.mock('../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), getAll: vi.fn().mockReturnValue({}) },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

import { finalizeApp } from '../app.js';

/**
 * Guards the production SPA serving path (`finalizeApp` under
 * NODE_ENV=production). Regression coverage for the Express 5 migration
 * (DOR-171): path-to-regexp v8 rejects a bare `app.get('*')`, and
 * `res.sendFile` with an absolute path 404s for multi-segment request URLs —
 * both would silently break client-side deep links in a packaged CLI.
 */
describe('finalizeApp — production SPA fallback (Express 5)', () => {
  let app: express.Express;

  /** A bundle named the way Vite names them: content hash in the filename. */
  const HASHED_ASSET = 'index-a1b2c3d4.js';

  beforeAll(() => {
    holder.dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-spa-fallback-'));
    fs.writeFileSync(path.join(holder.dist, 'index.html'), '<!doctype html><div id="root"></div>');
    // A Vite-shaped dist: content-hashed bundles under assets/, unhashed
    // static files at the root.
    fs.mkdirSync(path.join(holder.dist, 'assets'));
    fs.writeFileSync(path.join(holder.dist, 'assets', HASHED_ASSET), 'console.log(1);');
    fs.writeFileSync(path.join(holder.dist, 'favicon.ico'), 'icon');
    app = express();
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    finalizeApp(app);
  });

  afterAll(() => {
    fs.rmSync(holder.dist, { recursive: true, force: true });
  });

  it('serves index.html for a client-side deep link', async () => {
    const res = await request(app).get('/agents/deep/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('serves index.html for a deep link carrying a query string', async () => {
    const res = await request(app).get('/session?id=abc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('serves a HEAD deep link (Express auto-mapped HEAD->GET on app.get, so the fallback must too)', async () => {
    const res = await request(app).head('/agents/deep/route');
    expect(res.status).toBe(200);
  });

  it('returns the JSON API 404 for unknown /api routes, not the SPA shell', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('API_NOT_FOUND');
  });

  it('does not serve the SPA shell for non-GET requests', async () => {
    const res = await request(app).post('/agents/deep/route');
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
      const res = await request(app).get('/assets/nope-abc123.js');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('id="root"');
      expect(res.headers['cache-control']).not.toBe('no-store');
    });

    it('still serves an existing hashed bundle as 200 immutable', async () => {
      const res = await request(app).get(`/assets/${HASHED_ASSET}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('404s a HEAD request for a missing hashed bundle', async () => {
      const res = await request(app).head('/assets/nope-abc123.js');
      expect(res.status).toBe(404);
    });

    it('still serves a genuine deep client route as 200 index.html no-store', async () => {
      const res = await request(app).get('/agents/deep/route');
      expect(res.status).toBe(200);
      expect(res.text).toContain('id="root"');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('404s the exact /assets/ directory (no matching index file within it)', async () => {
      const res = await request(app).get('/assets/');
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
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never stores the shell requested by name', async () => {
      const res = await request(app).get('/index.html');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('never stores the shell served through the deep-link fallback', async () => {
      const res = await request(app).get('/agents/deep/route');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('caches a content-hashed bundle for a year, immutably', async () => {
      const res = await request(app).get(`/assets/${HASHED_ASSET}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('leaves unhashed root files (favicon) on the revalidating default', async () => {
      const res = await request(app).get('/favicon.ico');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).not.toContain('no-store');
      expect(res.headers['cache-control']).not.toContain('immutable');
    });
  });
});
