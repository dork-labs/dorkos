/**
 * `GET /api/config` reports `isLocalCaller` so the app can offer honest guidance
 * instead of a Sign in button that can only 403 from a phone (DOR-1655). A
 * report like that is worth nothing unless it agrees with the refusal it
 * describes, so this file asks BOTH surfaces about the SAME request shape and
 * compares their answers to each other.
 *
 * That comparison is what makes it discriminating. The report is asserted
 * against the LIVE refusal, never against a constant, so hard-coding
 * `isLocalCaller: true` in the config route — or computing it from
 * `req.hostname` rather than the raw `Host` header, the exact bug DOR-532 fixed
 * on the refusal side — reds the tunnel row here while every other test in the
 * repo stays green.
 *
 * It lives in its own file rather than inside `runtimes-connect.test.ts`
 * because mounting the config router drags in that route's whole import graph
 * (relay, skills, the config store), and that focused suite should not have to
 * carry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never spawn a vendor CLI: the login route is one of the two surfaces under
// test and its action would otherwise run `claude auth login` for real.
vi.mock('../../services/runtimes/connect/delegated-login.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/delegated-login.js')>();
  return { ...actual, delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }) };
});

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

// `getBoundary` throws unless `initBoundary()` ran at startup, which a bare test
// app never does. Nothing here reads the value; it only has to exist so the
// config handler reaches the field under test.
vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  expandTilde: (p: string) => (p.startsWith('~/') ? `/Users/test-user/${p.slice(2)}` : p),
}));

import express from 'express';
import request from 'supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import runtimesRouter from '../runtimes.js';
import configRouter from '../config.js';

/** The TCP peer the app reports for the current request. */
let currentPeer = '127.0.0.1';

const app = express();
app.use((req, _res, next) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: currentPeer, configurable: true });
  next();
});
app.use(express.json());
app.use('/api/runtimes', runtimesRouter);
app.use('/api/config', configRouter);
const server = listeningServer(app);

beforeEach(() => {
  currentPeer = '127.0.0.1';
});

describe('what GET /api/config reports and what the connect routes do (DOR-1655)', () => {
  const CALLERS = [
    { name: 'a browser on this machine', peer: '127.0.0.1', host: 'localhost', local: true },
    // The shape the whole change exists for. The tunnel agent runs on this
    // machine, so the TCP peer IS loopback; only the `Host` header — written by
    // the phone's browser from the address bar — gives the caller away.
    {
      name: 'a phone over the tunnel',
      peer: '127.0.0.1',
      host: 'quiet-otter-1234.ngrok.app',
      local: false,
    },
    // The LAN peer that defeated the header-only check in the DOR-532 probes.
    { name: 'a browser on the LAN', peer: '192.168.86.200', host: 'localhost', local: false },
  ];

  it.each(CALLERS)('$name is told exactly what it would be given', async (caller) => {
    currentPeer = caller.peer;
    const config = await request(server).get('/api/config').set('Host', caller.host);
    expect(config.status).toBe(200);

    currentPeer = caller.peer;
    const login = await request(server)
      .post('/api/runtimes/claude-code/login')
      .set('Host', caller.host)
      .send({});

    // The answer the app acts on, and the answer the endpoint actually gives.
    expect(config.body.isLocalCaller).toBe(caller.local);
    expect(config.body.isLocalCaller).toBe(login.status !== 403);
  });
});
