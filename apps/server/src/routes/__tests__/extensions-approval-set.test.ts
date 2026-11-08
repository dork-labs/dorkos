/**
 * The "Allow all" route's answer when a member fails part-way (DOR-3583,
 * Security Nov 8, M2). Purpose: whatever happens mid-way, the person gets a
 * 200 that names every member, and each member that now runs has its own
 * Activity entry, written as it was allowed.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'auth' ? { enabled: false } : {}) },
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

const outcome = vi.hoisted(() => ({
  results: [
    { id: 'social', name: 'Social', ok: true },
    { id: 'writer', name: 'Writer', ok: false, reason: 'DorkOS couldn’t turn it on.' },
    { id: 'cockpit', name: 'Cockpit', ok: true },
  ],
}));

// The service's own tests cover what it decides; here it reports a mixed
// answer, calling back for each member it allowed, the way the real one does.
vi.mock('../../services/extensions/groups/extension-approval-set.js', () => ({
  listApprovalSets: vi.fn(async () => []),
  approveExtensionSet: vi.fn(
    async (
      _source: unknown,
      _request: unknown,
      onAllowed: (result: { id: string; name: string; ok: boolean }) => Promise<void>
    ) => {
      for (const result of outcome.results) if (result.ok) await onAllowed(result);
      return { ok: true, results: outcome.results, allAllowed: false };
    }
  ),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { registerExtensionApprovalSetRoutes } from '../extensions-approval-set.js';
import type { PersonBarCopy } from '../extensions-person-bar.js';

const target = swappableServer();

const BAR: PersonBarCopy = {
  error: 'refused',
  code: 'extension_not_approved_to_run',
  subject: 'extensions',
  crossSite: () => 'refused',
  agent: 'refused',
};

const BODY = {
  plugin: 'marketing',
  members: [
    {
      id: 'social',
      version: '1.0.0',
      expectedDigest: 'digest',
      permissions: { runtime: 'subprocess', net: [], run: [], agents: false },
    },
  ],
  setHash: 'hash',
};

describe('POST /api/extensions/approve-set, part-way', () => {
  it('answers 200 with every member, and one Activity entry per member allowed', async () => {
    const emit = vi.fn(async (_entry: { resourceId?: string }) => {});
    const routes = new Hono<ApiEnv>();
    registerExtensionApprovalSetRoutes(routes, {} as never, BAR, { emit } as never);
    target.mount(honoGroupListener({ path: '/api/extensions', routes }));

    const res = await request(target.server).post('/api/extensions/approve-set').send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: outcome.results, allAllowed: false });
    expect(emit.mock.calls.map(([entry]) => entry.resourceId)).toEqual(['social', 'cockpit']);
  });
});
