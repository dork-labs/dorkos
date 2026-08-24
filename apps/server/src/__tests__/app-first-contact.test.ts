import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// A throwaway client dist, so the SPA branch has an index.html to serve. Same
// shape as `app-spa-fallback.test.ts`: vi.hoisted holds the mutable ref (it
// runs before imports, so it cannot build a path from `os`/`path`) and the env
// mock reads it lazily through a getter.
const holder = vi.hoisted(() => ({ dist: '' }));

// finalizeApp's SPA branch is skipped under NODE_ENV=test, and the shell marker
// lives inside it.
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

// Singletons with load or first-use side effects, mocked so importing app.js
// never touches ~/.dork or a real runtime.
vi.mock('../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (target: string) => target),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));
vi.mock('../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => ({ type: 'claude-code' })),
    getDefaultType: vi.fn(() => 'claude-code'),
    getAllCapabilities: vi.fn(() => ({})),
    has: vi.fn(() => true),
    get: vi.fn(() => ({ type: 'claude-code' })),
    resolveForSession: vi.fn(async () => ({ type: 'claude-code' })),
  },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../app.js';
import { logger } from '../lib/logger.js';

/** The marker logged the first time a boot serves the SPA shell. */
const SHELL_MARKER = '[Client] first index.html served';
/** The marker logged the first time a boot is handed an API request. */
const API_MARKER = '[Client] first API request';

/** Every `info` line logged so far that is one of the two markers. */
function markers(): string[] {
  return vi
    .mocked(logger.info)
    .mock.calls.map(([first]) => first)
    .filter((line): line is string => line === SHELL_MARKER || line === API_MARKER);
}

/** A finished app: real API mounts, real SPA serving, nothing else. */
function bootApp(): express.Express {
  const app = createApp();
  finalizeApp(app);
  return app;
}

/**
 * Guards the first-client-contact markers.
 *
 * Successful requests are logged at `debug`, so a user's log at the default
 * level says nothing at all while everything works — which is exactly why an
 * incident spent a day unable to answer "did the cockpit ever reach the server?"
 * These two `info` lines answer it, and they are only useful if there is
 * precisely one of each per boot: a line per request would drown the log it is
 * meant to make readable, and a line that never fires answers nothing.
 */
describe('first-client-contact markers', () => {
  /** A bundle named the way Vite names them: content hash in the filename. */
  const HASHED_ASSET = 'index-a1b2c3d4.js';

  beforeAll(() => {
    holder.dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-first-contact-'));
    fs.writeFileSync(path.join(holder.dist, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.mkdirSync(path.join(holder.dist, 'assets'));
    fs.writeFileSync(path.join(holder.dist, 'assets', HASHED_ASSET), 'console.log(1);');
  });

  afterAll(() => {
    fs.rmSync(holder.dist, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Restored first: `vi.spyOn` on an already-spied method hands back the
    // same spy with its call history intact, which would let one test's
    // markers count towards the next one's assertions.
    vi.restoreAllMocks();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  it('logs the shell marker once, however many times the shell is served', async () => {
    const app = bootApp();

    await request(app).get('/');
    await request(app).get('/index.html');
    await request(app).get('/agents/deep/route');

    expect(markers()).toEqual([SHELL_MARKER]);
  });

  it('logs the shell marker for a deep link, where no file is served by static', async () => {
    const app = bootApp();

    await request(app).get('/agents/deep/route');

    expect(markers()).toEqual([SHELL_MARKER]);
  });

  it('logs the API marker once, however many API requests arrive', async () => {
    const app = bootApp();

    await request(app).get('/api/health');
    await request(app).get('/api/nope');
    await request(app).post('/api/also-nope').send({});

    expect(markers()).toEqual([API_MARKER]);
  });

  it('counts an API request that is rejected — arriving is what it claims', async () => {
    // The marker is mounted ahead of the host guard and the session gate: a
    // request they turn away still proves the client reached this process,
    // which is the only question the line answers.
    const app = bootApp();

    await request(app).get('/api/nope');

    expect(markers()).toEqual([API_MARKER]);
  });

  it('logs both markers, once each, over a realistic first load', async () => {
    const app = bootApp();

    await request(app).get('/');
    await request(app).get(`/assets/${HASHED_ASSET}`);
    await request(app).get('/api/health');
    await request(app).get('/api/health');
    await request(app).get('/session');

    expect(markers()).toEqual([SHELL_MARKER, API_MARKER]);
  });

  it('does not claim the shell was served when there is no shell to serve', async () => {
    // A dist without an index.html is the boot where this line gets read most
    // carefully, and where claiming it before the send would mislead most.
    const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-first-contact-empty-'));
    const previousDist = holder.dist;
    holder.dist = emptyDist;
    try {
      const app = bootApp();

      await request(app).get('/agents/deep/route');

      expect(markers()).toEqual([]);
    } finally {
      holder.dist = previousDist;
      fs.rmSync(emptyDist, { recursive: true, force: true });
    }
  });

  it('does not log the shell marker for a hashed bundle — only for the shell', async () => {
    const app = bootApp();

    await request(app).get(`/assets/${HASHED_ASSET}`);

    expect(markers()).toEqual([]);
  });

  it('starts fresh on the next boot, rather than latching for the process lifetime', async () => {
    // "First" means first this boot. A module-level latch would pass every test
    // above and then stay silent for every restart after the first.
    await request(bootApp()).get('/');
    await request(bootApp()).get('/');

    expect(markers()).toEqual([SHELL_MARKER, SHELL_MARKER]);
  });

  it('leaves the per-request logging alone', async () => {
    const app = bootApp();

    await request(app).get('/api/health');
    await request(app).get('/api/health');

    // Two requests, one marker: the request logger still decides on its own
    // what to say about each request, at its own level.
    expect(markers()).toHaveLength(1);
  });
});
