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
    { id: 'board', name: 'Board', ok: true },
  ],
}));

// The service's own tests cover what it decides; here it reports a mixed
// answer, calling back for each member it allowed, the way the real one does.
vi.mock('../../services/extensions/groups/extension-approval-set.js', () => ({
  listApprovalSets: vi.fn(async () => []),
  checkExtensionSetApproval: vi.fn(async () => ({ ok: true, waiting: [] })),
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
import {
  approvalConfirmationRoutes,
  finishApprovalForTest,
} from './approval-confirmation-driver.js';
import { setTestOwner } from './test-owner.js';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { approveExtensionSet } from '../../services/extensions/groups/extension-approval-set.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
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
  function mountDesk(emit: ReturnType<typeof vi.fn>, user?: { userId: string; sessionId: string }) {
    const routes = new Hono<ApiEnv>();
    registerExtensionApprovalSetRoutes(routes, { get: () => null } as never, BAR, {
      emit,
    } as never);
    target.mount(
      honoGroupListener(
        [
          { path: '/api/extensions', routes },
          { path: '/api/step-up', routes: approvalConfirmationRoutes('http://localhost:7777') },
        ],
        {
          before: async (c, next) => {
            if (user) c.set('user', { ...user, credential: 'cookie' });
            await next();
          },
        }
      )
    );
  }

  it('answers 200 at once at this computer while nobody has registered, one Activity entry per member allowed', async () => {
    const emit = vi.fn(async (_entry: { resourceId?: string }) => {});
    mountDesk(emit);

    const res = await request(target.server).post('/api/extensions/approve-set').send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: outcome.results, allAllowed: false });
    expect(emit.mock.calls.map(([entry]) => entry.resourceId)).toEqual(['social', 'board']);
  });

  it('holds the set at this computer once an owner exists, then answers 200 with every member', async () => {
    const emit = vi.fn(async (_entry: { resourceId?: string }) => {});
    mountDesk(emit, { userId: 'owner', sessionId: 'desk' });
    setTestOwner('owner');
    try {
      const held = await request(target.server).post('/api/extensions/approve-set').send(BODY);

      expect(held.status).toBe(428);
      expect(emit).not.toHaveBeenCalled();
      const res = await finishApprovalForTest(target.server, held, 'http://localhost:7777');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ results: outcome.results, allAllowed: false });
      expect(emit.mock.calls.map(([entry]) => entry.resourceId)).toEqual(['social', 'board']);
    } finally {
      setTestOwner(null);
    }
  });
  it('tells a Wi-Fi "Allow all" of two to answer at the computer, applying nothing', async () => {
    vi.mocked(approveExtensionSet).mockClear();
    const routes = new Hono<ApiEnv>();
    registerExtensionApprovalSetRoutes(routes, { get: () => null } as never, BAR);
    target.mount(
      honoGroupListener(
        { path: '/api/extensions', routes },
        {
          before: async (c, next) => {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', {
              userId: 'owner',
              credential: 'cookie',
              sessionId: 'phone',
              route: 'wifi',
            });
            await next();
          },
        }
      )
    );
    const response = await request(target.server)
      .post('/api/extensions/approve-set')
      .set('Origin', 'http://localhost:7777')
      .send({ ...BODY, members: [BODY.members[0], { ...BODY.members[0], id: 'writer' }] });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Answer at your computer or over Remote Access.',
      code: 'NOT_FROM_WIFI',
    });
    expect(approveExtensionSet).not.toHaveBeenCalled();
  });

  it.each(['own-tunnel', 'managed'] as const)(
    'holds a one-member set from %s until the person confirms',
    async (via) => {
      vi.mocked(approveExtensionSet).mockClear();
      const routes = new Hono<ApiEnv>();
      registerExtensionApprovalSetRoutes(routes, { get: () => null } as never, BAR);
      target.mount(
        honoGroupListener(
          [
            { path: '/api/extensions', routes },
            { path: '/api/step-up', routes: approvalConfirmationRoutes('http://localhost:7777') },
          ],
          {
            before: async (c, next) => {
              markIngress(c.env.incoming, via);
              c.set('user', {
                userId: 'owner',
                credential: 'cookie',
                sessionId: 'phone',
                route: 'tunnel',
              });
              await next();
            },
          }
        )
      );
      setTestOwner('owner');
      try {
        const held = await request(target.server)
          .post('/api/extensions/approve-set')
          .set('Origin', 'http://localhost:7777')
          .send(BODY);
        expect(held.status).toBe(428);
        expect(approveExtensionSet).not.toHaveBeenCalled();
        const res = await finishApprovalForTest(target.server, held, 'http://localhost:7777');
        expect(res.status).toBe(200);
        expect(approveExtensionSet).toHaveBeenCalledTimes(1);
      } finally {
        setTestOwner(null);
      }
    }
  );

  it('refuses a remote multi-member batch before any member is applied', async () => {
    vi.mocked(approveExtensionSet).mockClear();
    const routes = new Hono<ApiEnv>();
    registerExtensionApprovalSetRoutes(routes, { get: () => null } as never, BAR);
    target.mount(
      honoGroupListener(
        { path: '/api/extensions', routes },
        {
          before: async (c, next) => {
            markIngress(c.env.incoming, 'own-tunnel');
            c.set('user', {
              userId: 'owner',
              credential: 'cookie',
              sessionId: 'phone',
              route: 'tunnel',
            });
            await next();
          },
        }
      )
    );
    const response = await request(target.server)
      .post('/api/extensions/approve-set')
      .set('Origin', 'http://localhost:7777')
      .send({ ...BODY, members: [BODY.members[0], { ...BODY.members[0], id: 'writer' }] });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('APPROVALS_REQUIRE_SEPARATE_CONFIRMATION');
    expect(approveExtensionSet).not.toHaveBeenCalled();
  });
});
