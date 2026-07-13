/**
 * Tests for `POST /api/errors` (DOR-318): the route always accepts (202), and a
 * HOSTILE client payload is re-scrubbed SERVER-SIDE before anything leaves —
 * absolute paths, home dirs, tokens, and the raw message never reach the ingest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import errorRoutes from '../errors.js';
import {
  registerServerErrorReporting,
  type RegisterServerErrorReportingOptions,
} from '../../services/core/error-reporter.js';

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/errors', errorRoutes);
  return app;
}

function register(fetchImpl: typeof fetch, consent: boolean): void {
  const opts: RegisterServerErrorReportingOptions = {
    consent,
    version: '0.46.0',
    environment: 'production',
    cwd: '/srv/dorkos',
    dorkHome: fs.mkdtempSync(path.join(os.tmpdir(), 'route-err-')),
    debug: false,
    endpoint: 'https://ingest.test/api/telemetry/events',
    fetchImpl,
  };
  registerServerErrorReporting(opts);
}

afterEach(() => {
  register(vi.fn(), false); // tear down the singleton
  vi.clearAllMocks();
});

describe('POST /api/errors', () => {
  it('re-scrubs a hostile client payload server-side, then 202s', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    register(fetchSpy, true);

    const res = await request(makeApp())
      .post('/api/errors')
      .send({
        name: 'Err_/Users/alice',
        message: 'user said hello; token sk-abcdef0123456789ABCDEF',
        stack: [
          'Error: boom',
          '    at h (/Users/alice/secret-client/apps/client/src/x.ts:5:9)',
          '    at C:\\Users\\alice\\dev\\y.ts:3:2',
        ].join('\n'),
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });

    // The send is fire-and-forget and resolves an async instance id (fs read)
    // first — poll briefly for the outbound fetch.
    await waitFor(() => fetchSpy.mock.calls.length > 0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
    expect(body).not.toContain('alice');
    expect(body).not.toContain('secret-client');
    expect(body).not.toContain('sk-abcdef0123456789ABCDEF');
    expect(body).not.toContain('user said hello');
    expect(body).not.toContain('C:\\Users');
    expect(body).toContain('"surface":"client"');
  });

  it('accepts and drops when error reporting is off (still 202)', async () => {
    const fetchSpy = vi.fn();
    register(fetchSpy, false);

    const res = await request(makeApp())
      .post('/api/errors')
      .send({ name: 'TypeError', message: 'x', stack: 'Error: x' });

    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts an empty body without erroring', async () => {
    register(vi.fn(), true);
    const res = await request(makeApp()).post('/api/errors').send({});
    expect(res.status).toBe(202);
  });
});
