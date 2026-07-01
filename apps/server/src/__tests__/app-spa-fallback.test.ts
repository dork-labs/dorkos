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

  beforeAll(() => {
    holder.dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-spa-fallback-'));
    fs.writeFileSync(path.join(holder.dist, 'index.html'), '<!doctype html><div id="root"></div>');
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
});
