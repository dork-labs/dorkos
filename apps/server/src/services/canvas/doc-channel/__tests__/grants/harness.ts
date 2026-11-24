/**
 * Shared setup for the grants suites: everything the original file declared or
 * registered outside its tests.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approvals, createDb, runMigrations, type Db } from '@dorkos/db';
import { ApprovalService } from '../../../../core/approvals/approval-service.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { DocChannelStore } from '../../store.js';
import { DocChannelGrants } from '../../grants.js';
import {
  DocRouteGrantError,
  type DocGrantActor,
  type DocGrantAuthority,
  type DocRouteGrantRequest,
  type DocGrantTarget,
} from '../../grant-policy.js';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';

/** What each test runs against; the hooks below reset it. */
export const st = {
  db: undefined as unknown as Db,
  store: undefined as unknown as DocChannelStore,
  approval: undefined as unknown as ApprovalService,
  service: undefined as unknown as DocChannelGrants,
  authority: undefined as unknown as DocGrantAuthority,
  dir: undefined as unknown as string,
  currentTarget: undefined as unknown as DocGrantTarget,
  currentOrigin: undefined as unknown as boolean,
  allowed: undefined as unknown as boolean,
  clock: undefined as unknown as Date,
};

export const owner = { kind: 'local_install' as const, installationId: 'installation' };

export const actor: DocGrantActor = {
  surface: 'capability',
  principal: createServerPrincipal({
    kind: 'runtime',
    owner,
    bindingId: 'binding',
    runtime: 'claude-code',
    canonicalSessionId: 'session-a',
    agentId: 'opener',
    agentPath: '/tmp/opener',
  }),
};

export const operator: DocGrantActor = {
  surface: 'capability',
  principal: createServerPrincipal({ kind: 'operator', owner }),
};

export const ownRoute: CanvasChannelRoute = {
  id: 'route-a',
  on: 'task.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
};

export const otherRoute: CanvasChannelRoute = { ...ownRoute, to: 'agent:other' };

export function request(overrides: Partial<DocRouteGrantRequest> = {}): DocRouteGrantRequest {
  return {
    documentId: 'doc-a',
    routeId: 'route-a',
    expiresAt: new Date(st.clock.getTime() + 3600000).toISOString(),
    ...overrides,
  };
}

export function configure(route = ownRoute): void {
  st.service.configure('doc-a', { routes: [route] }, actor);
}

export function approved(req = request()) {
  const result = st.service.grant(req, actor);
  expect(result.kind).toBe('approval_required');
  if (result.kind !== 'approval_required') throw new Error('Expected approval ticket');
  expect(st.approval.grant(result.ticket.approvalId)).toBeUndefined();
  return result.ticket;
}

export function grant(req = request(), token?: string) {
  const result = st.service.grant(req, actor, token);
  if (result.kind !== 'granted') throw new Error('Expected grant');
  return result.grant;
}

beforeEach(() => {
  st.db = createDb(':memory:');
  runMigrations(st.db);
  st.store = new DocChannelStore(st.db);
  st.clock = new Date();
  st.currentOrigin = true;
  st.allowed = true;
  st.currentTarget = {
    agentId: 'opener',
    sessionId: 'session-a',
    runtime: 'claude-code',
    agentPath: '/tmp/opener',
    scope: 'session:session-a',
  };
  st.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-grants-'));
  fs.mkdirSync(path.join(st.dir, '.dork'));
  st.store.initialize({
    documentId: 'doc-a',
    scope: 'session:session-a',
    openerAgentId: 'opener',
    createdAt: st.clock.toISOString(),
    updatedAt: st.clock.toISOString(),
  });
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  st.approval = new ApprovalService(st.db);
  st.authority = {
    resolveScope: (scope) => scope,
    requireCurrent(documentId) {
      if (!st.allowed) throw new DocRouteGrantError('ACCESS_LOST');
      return { id: documentId, scope: 'session:session-a' };
    },
    requireGrantedCurrent(row) {
      if (!st.allowed) throw new DocRouteGrantError('ACCESS_LOST');
      return { id: row.documentId, scope: 'session:session-a' };
    },
    resolveTarget({ route }) {
      return route.to === 'log'
        ? {
            agentId: null,
            sessionId: null,
            runtime: null,
            agentPath: null,
            scope: 'session:session-a',
          }
        : st.currentTarget;
    },
    sourceRoot: () => st.dir,
    originCurrent: () => st.currentOrigin,
  };
  st.service = new DocChannelGrants({
    db: st.db,
    store: st.store,
    approvals: st.approval,
    authority: st.authority,
    now: () => st.clock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  st.db?.$client.close();
  if (st.dir) fs.rmSync(st.dir, { recursive: true, force: true });
});
