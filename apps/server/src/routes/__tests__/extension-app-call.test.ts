/**
 * One app calling another's routes, as the server checks it (DOR-3293,
 * Security 2026-11-10): both manifests must agree, the target must run, a
 * personOnly route is never reached, and every call is recorded with both ids.
 * The calling app comes only from the caller token its frame load was given.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { Router } from 'express';
import type { ExtensionManifest } from '@dorkos/extension-api';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const recordAudit = vi.hoisted(() => vi.fn());
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit,
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { bridgeExpressRouter } from '../../services/extensions/http/express-bridge.js';
import { createExtensionApiRoutes } from '../extension-api.js';
import { MAX_CALLER_TOKENS, resetCallerTokens } from '../extension-caller-token.js';
import type { AddressInfo } from 'node:net';
import { createExtensionFrameRoutes } from '../extension-frame.js';

const manifests: Record<string, ExtensionManifest> = {
  reports: {
    id: 'reports',
    name: 'Reports',
    version: '1.0.0',
    capabilities: { http: { apps: ['ledger'] } },
  },
  ledger: {
    id: 'ledger',
    name: 'Ledger',
    version: '1.0.0',
    capabilities: { http: true },
    exports: {
      http: [
        { path: '/entries', methods: ['GET'] },
        { path: '/entries/:id', methods: ['GET', 'PATCH'] },
        { path: '/approvals', methods: ['GET'] },
      ],
      personOnly: ['/approve', { path: '/approvals', methods: ['POST'] }],
    },
  },
  idle: {
    id: 'idle',
    name: 'Idle',
    version: '1.0.0',
    capabilities: { http: { apps: ['ledger'] } },
  },
};
const running = new Set(['reports', 'ledger']);

/** What Ledger's routes saw, so a test can tell a refusal from an answer. */
const seen: { method: string; path: string; caller?: string; token?: string }[] = [];
const ledgerRoutes = Router();
ledgerRoutes.use((req, res) => {
  seen.push({
    method: req.method,
    path: req.path,
    caller: req.get('x-dorkos-caller-app') ?? undefined,
    token: req.get('x-dorkos-caller-token') ?? undefined,
  });
  res.json({ ok: true });
});
const ledgerHandler = bridgeExpressRouter(ledgerRoutes);

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

/** The person the session gate proved, per request: a cookie session by default. */
let user: { userId: string; credential: 'cookie' | 'api-key'; sessionId?: string } | undefined;

beforeEach(() => {
  seen.length = 0;
  recordAudit.mockClear();
  resetCallerTokens();
  user = { userId: 'u1', credential: 'cookie', sessionId: 'sess-1' };
  const records = {
    manifest: (id: string) => manifests[id],
    callerRuns: (id: string) => running.has(id),
  };
  fixtureTarget.mount(
    honoGroupListener(
      [
        {
          path: '/api/ext',
          routes: createExtensionApiRoutes(
            {
              getServerHandler: (id) => (id === 'ledger' && running.has(id) ? ledgerHandler : null),
            },
            records
          ),
        },
        {
          path: '/api/extension-frame',
          routes: createExtensionFrameRoutes({
            appScreenRuns: records.callerRuns,
            manifest: records.manifest,
          }),
        },
      ],
      {
        before: (c, next) => {
          if (user) c.set('user', user as never);
          return next();
        },
      }
    )
  );
});

/** Ask for a caller token for one frame load of `appId`, as the window does. */
/** This server's own origin, as a DorkOS window's fetch names it. */
const ownOrigin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Ask to mint, as the window does, from `origin` (its own by default). */
const mintRequest = (appId: string, origin: string | null = ownOrigin()) => {
  const call = request(server).post('/api/extension-frame/caller-token');
  return (origin === null ? call : call.set('Origin', origin)).send({ appId });
};

async function mint(appId: string): Promise<string> {
  const res = await mintRequest(appId);
  expect(res.status).toBe(201);
  return res.body.token as string;
}

/** A call from Reports' frame, as the window makes it. */
async function asReports(method: 'get' | 'post' | 'patch', path: string, body?: object) {
  const token = await mint('reports');
  const call = request(server)
    [method](`/api/ext/ledger${path}`)
    .set('X-DorkOS-Caller-Token', token)
    .set('X-DorkOS-Caller-App', 'reports')
    .set('X-DorkOS-Extension', 'reports');
  return body ? call.send(body) : call;
}

describe('a call from one app to another', () => {
  it('reaches an exported read; the target sees who called, never the token', async () => {
    const res = await asReports('get', '/entries');
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { method: 'GET', path: '/entries', caller: 'reports', token: undefined },
    ]);
  });

  it('reaches an exported write only where its method is listed', async () => {
    expect((await asReports('patch', '/entries/e-17', { memo: 'x' })).status).toBe(200);
    const refused = await asReports('post', '/entries', { memo: 'x' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'app_call_refused', reason: 'method-not-exported' });
    expect(seen).toHaveLength(1);
  });

  it('refuses a route the target does not export, and a personOnly one', async () => {
    expect((await asReports('get', '/secrets')).body.reason).toBe('not-exported');
    expect((await asReports('post', '/approve')).body.reason).toBe('person-only');
    expect(seen).toHaveLength(0);
  });

  it('reaches a read on a path whose write is personOnly, never the write', async () => {
    expect((await asReports('get', '/approvals')).status).toBe(200);
    const refused = await asReports('post', '/approvals', { yes: true });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'app_call_refused', reason: 'person-only' });
    expect(seen).toEqual([
      { method: 'GET', path: '/approvals', caller: 'reports', token: undefined },
    ]);
  });

  it('refuses a target that is not running', async () => {
    const token = await mint('reports');
    running.delete('ledger');
    try {
      const res = await request(server)
        .get('/api/ext/ledger/entries')
        .set('X-DorkOS-Caller-Token', token);
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('target-unavailable');
    } finally {
      running.add('ledger');
    }
  });

  it('records each call with both ids, allowed or refused', async () => {
    await asReports('get', '/entries');
    await asReports('get', '/secrets');
    expect(recordAudit).toHaveBeenCalledTimes(2);
    for (const [event] of recordAudit.mock.calls) {
      expect(event).toMatchObject({
        action: 'extension.app_call',
        target: { type: 'extension', id: 'ledger' },
      });
      expect(event.change).toContainEqual({ field: 'callerApp', after: 'reports' });
    }
    expect(recordAudit.mock.calls.map(([event]) => event.outcome)).toEqual(['ok', 'refused']);
  });

  it('leaves an app’s own call alone', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/approve')
      .set('X-DorkOS-Extension', 'ledger');
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('who the calling app is (Security 2026-11-10)', () => {
  it('refuses a person session with a hand-written caller header and no token', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-App', 'reports');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('no-token');
    expect(seen).toHaveLength(0);
  });

  it('refuses a stamp naming another app with no token', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Extension', 'reports');
    expect(res.body.reason).toBe('no-token');
    expect(seen).toHaveLength(0);
  });

  it('never lets a token minted for one app call as another', async () => {
    manifests.quill = {
      id: 'quill',
      name: 'Quill',
      version: '1.0.0',
      capabilities: { http: { apps: ['ledger'] } },
    };
    running.add('quill');
    try {
      const forQuill = await mint('quill');
      const res = await request(server)
        .get('/api/ext/ledger/entries')
        .set('X-DorkOS-Caller-Token', forQuill)
        .set('X-DorkOS-Caller-App', 'reports');
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('mismatch');
      // With no header at all, the call is Quill's, never Reports'.
      await request(server).get('/api/ext/ledger/entries').set('X-DorkOS-Caller-Token', forQuill);
      expect(recordAudit.mock.calls.at(-1)?.[0].change).toContainEqual({
        field: 'callerApp',
        after: 'quill',
      });
    } finally {
      running.delete('quill');
      delete manifests.quill;
    }
  });

  it('refuses a token from a session that is gone', async () => {
    const token = await mint('reports');
    user = { userId: 'u1', credential: 'cookie', sessionId: 'sess-2' };
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('caller_token_invalid');
    user = { userId: 'u1', credential: 'cookie', sessionId: 'sess-1' };
    // Refused once means forgotten: the old session cannot use it either.
    const again = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', token);
    expect(again.body.code).toBe('caller_token_invalid');
    expect(seen).toHaveLength(0);
  });

  it('stops a call at once when an update drops the app from its list, token and all', async () => {
    const token = await mint('reports');
    const before = manifests.reports!;
    // The update lands: the same app, now calling nothing.
    manifests.reports = { ...before, capabilities: { http: true } };
    try {
      const res = await request(server)
        .get('/api/ext/ledger/entries')
        .set('X-DorkOS-Caller-Token', token);
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('not-declared');
      expect(seen).toHaveLength(0);
    } finally {
      manifests.reports = before;
    }
  });

  it('refuses a made-up token', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', 'not-a-token');
    expect(res.body.code).toBe('caller_token_invalid');
  });

  it('refuses an API key that mints, or sends a token or the header', async () => {
    const token = await mint('reports');
    user = { userId: 'u1', credential: 'api-key' };
    const minted = await mintRequest('reports');
    expect(minted.status).toBe(403);
    const withToken = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', token);
    expect(withToken.body.reason).toBe('not-a-window');
    const withHeader = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-App', 'reports');
    expect(withHeader.body.reason).toBe('not-a-window');
    expect(seen).toHaveLength(0);
  });

  it('refuses an agent that mints, or sends a token or the header', async () => {
    const token = await mint('reports');
    const minted = await request(server)
      .post('/api/extension-frame/caller-token')
      .set('Origin', ownOrigin())
      .set('X-DorkOS-Agent', 'agent-token')
      .send({ appId: 'reports' });
    expect(minted.status).toBeGreaterThanOrEqual(401);
    const withToken = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Agent', 'agent-token')
      .set('X-DorkOS-Caller-Token', token);
    expect(withToken.status).toBeGreaterThanOrEqual(401);
    expect(seen).toHaveLength(0);
  });

  it('never mints for a page elsewhere, an opaque page, or a request naming no page', async () => {
    for (const origin of ['https://elsewhere.example', 'null', null]) {
      const res = await mintRequest('reports', origin);
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.token).toBeUndefined();
    }
  });

  it('keeps no more than the cap of live tokens, letting the oldest go', async () => {
    const first = await mint('reports');
    for (let i = 0; i < MAX_CALLER_TOKENS; i++) await mint('reports');
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', first);
    expect(res.body.code).toBe('caller_token_invalid');
    const fresh = await mint('reports');
    const ok = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-Token', fresh);
    expect(ok.status).toBe(200);
  }, 30_000);

  it('mints only for a running app that calls another', async () => {
    for (const appId of ['ledger', 'idle', 'no-such-app', '']) {
      const res = await mintRequest(appId);
      expect(res.status, appId).toBe(400);
    }
  });
});
