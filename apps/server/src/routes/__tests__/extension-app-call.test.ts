/**
 * One app calling another's routes, as the server checks it (DOR-3293,
 * Security 2026-11-10): both manifests must agree, the target must run, a
 * personOnly route is never reached, and every call is recorded with both ids.
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
      ],
      personOnly: ['/approve'],
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
const seen: { method: string; path: string; caller?: string }[] = [];
const ledgerRoutes = Router();
ledgerRoutes.use((req, res) => {
  seen.push({
    method: req.method,
    path: req.path,
    caller: req.get('x-dorkos-caller-app') ?? undefined,
  });
  res.json({ ok: true });
});
const ledgerHandler = bridgeExpressRouter(ledgerRoutes);

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

beforeEach(() => {
  seen.length = 0;
  recordAudit.mockClear();
  fixtureTarget.mount(
    honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes(
        { getServerHandler: (id) => (id === 'ledger' && running.has(id) ? ledgerHandler : null) },
        { manifest: (id) => manifests[id], callerRuns: (id) => running.has(id) }
      ),
    })
  );
});

const asReports = (method: 'get' | 'post' | 'patch', path: string) =>
  request(server)
    [method](`/api/ext/ledger${path}`)
    .set('X-DorkOS-Caller-App', 'reports')
    .set('X-DorkOS-Extension', 'reports');

describe('a call from one app to another', () => {
  it('reaches an exported read, and the target sees who called', async () => {
    const res = await asReports('get', '/entries');
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ method: 'GET', path: '/entries', caller: 'reports' }]);
  });

  it('reaches an exported write only where its method is listed', async () => {
    expect((await asReports('patch', '/entries/e-17').send({ memo: 'x' })).status).toBe(200);
    const refused = await asReports('post', '/entries').send({ memo: 'x' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'app_call_refused', reason: 'method-not-exported' });
    expect(seen).toHaveLength(1);
  });

  it('refuses a route the target does not export', async () => {
    const res = await asReports('get', '/secrets');
    expect(res.body.reason).toBe('not-exported');
    expect(seen).toHaveLength(0);
  });

  it('refuses a personOnly route, even to a listed caller', async () => {
    const res = await asReports('post', '/approve');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('person-only');
    expect(seen).toHaveLength(0);
  });

  it('refuses a caller that does not list the target', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-App', 'quill');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('not-declared');
    expect(seen).toHaveLength(0);
  });

  it('refuses a caller whose screens are not running', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-App', 'idle');
    expect(res.body.reason).toBe('not-declared');
  });

  it('refuses a target that is not running', async () => {
    running.delete('ledger');
    try {
      const res = await asReports('get', '/entries');
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('target-unavailable');
    } finally {
      running.add('ledger');
    }
  });

  it('treats a stamp naming another app as that app’s call, and checks it the same way', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/secrets')
      .set('X-DorkOS-Extension', 'reports');
    expect(res.body.reason).toBe('not-exported');
    expect(seen).toHaveLength(0);
  });

  it('refuses a call that names two different apps', async () => {
    const res = await request(server)
      .get('/api/ext/ledger/entries')
      .set('X-DorkOS-Caller-App', 'reports')
      .set('X-DorkOS-Extension', 'quill');
    expect(res.body.reason).toBe('mismatch');
    expect(seen).toHaveLength(0);
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
