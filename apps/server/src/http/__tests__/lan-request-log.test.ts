/**
 * Every request from another device is on record, accepted or refused, with its address, and
 * never with a secret (DOR-5042). Through the real chain, config and auth in a throwaway data
 * folder; only the logger is watched.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { createApiApp } from '../api-chain.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { initAuth } from '../../services/core/auth/index.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { resetLanLineLimits } from '../../middleware/request-logger.js';

let tmpDir: string;
const trustProxy = env.DORKOS_TRUST_PROXY;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-lan-request-log-'));
  initConfigManager(tmpDir);
  const db = createDb(path.join(tmpDir, 'lan-log-test.db'));
  runMigrations(db);
  initAuth(db, tmpDir);
});
afterAll(() => {
  env.DORKOS_TRUST_PROXY = trustProxy;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  env.DORKOS_TRUST_PROXY = false;
  resetLanLineLimits();
});
afterEach(() => vi.restoreAllMocks());

/** Send one request from `peer`, let it finish, and return the lines the logger got. */
async function send(
  peer: string,
  url: string,
  headers: Record<string, string> = {},
  end: 'finish' | 'close' = 'finish'
) {
  const info = vi.spyOn(logger, 'info');
  const warn = vi.spyOn(logger, 'warn');
  const debug = vi.spyOn(logger, 'debug');
  const app = createApiApp({ admission: new MainRequestAdmission() });
  app.all('/api/test', (c) => c.json({ ok: true }));
  const allHeaders = { host: 'localhost:4242', ...headers };
  const outgoing = Object.assign(new EventEmitter(), { setHeader: vi.fn(), statusCode: 0 });
  const incoming = { headers: allHeaders, socket: { remoteAddress: peer }, url };
  const res = await app.request(url, { headers: allHeaders }, { incoming, outgoing });
  outgoing.statusCode = res.status;
  outgoing.emit(end);
  const lines = [...info.mock.calls, ...warn.mock.calls, ...debug.mock.calls] as unknown[][];
  return { res, lines };
}

/** The request lines written for another device. */
function lanLines(lines: unknown[][]) {
  return lines.filter((line) => line[1] === 'request from another device') as [
    Record<string, unknown>,
    string,
  ][];
}

describe('the request log and another device (DOR-5042)', () => {
  it('records a request from the network that is refused, with its address and status', async () => {
    const { res, lines } = await send('192.168.1.40', '/api/test?token=made-up-secret', {
      authorization: 'Bearer made-up-bearer',
      cookie: 'session=made-up-cookie',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const lan = lanLines(lines);
    expect(lan).toHaveLength(1);
    expect(lan[0]![0]).toEqual({
      method: 'GET',
      path: '/api/test',
      status: res.status,
      ms: expect.any(Number),
      client: '192.168.1.40',
    });
    const written = JSON.stringify(lines);
    for (const secret of ['made-up-secret', 'made-up-bearer', 'made-up-cookie'])
      expect(written).not.toContain(secret);
  });

  it('adds no such line for a request from this machine, only its usual one', async () => {
    const { res, lines } = await send('127.0.0.1', '/api/test');
    expect(res.status).toBe(200);
    expect(lanLines(lines)).toHaveLength(0);
    expect(lines.filter((line) => line[1] === 'request')).toHaveLength(1);
  });

  it('records a request from the network whose connection closed before it finished', async () => {
    const { lines } = await send('192.168.1.41', '/api/test', {}, 'close');
    expect(lanLines(lines)[0]?.[0]).toMatchObject({ client: '192.168.1.41', aborted: true });
  });
});
