/**
 * `POST /api/connectors/holds/:holdId/cancel` (spec `trusted-by-default-flip`
 * §5.6): a person or another agent cancels an agent's held action; the agent
 * that asked cannot. Driven through the real `/api` chain and identity
 * middleware, so who is cancelling is read exactly as production reads it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ATLAS_TOKEN = 'tok_atlas';
const SCOUT_TOKEN = 'tok_scout';
const IDENTITIES: Record<string, { agentPath: string; displayName: string; createdAt: string }> = {
  [ATLAS_TOKEN]: { agentPath: '/agents/atlas', displayName: 'Atlas', createdAt: '2026-10-01' },
  [SCOUT_TOKEN]: { agentPath: '/agents/scout', displayName: 'Scout', createdAt: '2026-10-01' },
};

vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) => IDENTITIES[token] ?? null,
  }),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createConnectorHoldRoutes } from '../connector-holds.js';
import { DestructiveHoldService } from '../../services/connectors/execution/destructive-hold.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const target = swappableServer();

let holds: DestructiveHoldService;
let holdId: string;
let ended: Promise<unknown>;

beforeEach(async () => {
  holds = new DestructiveHoldService({
    activity: { tryEmit: async () => true, listByEventTypes: async () => [] },
    notify: vi.fn(async () => ({ notification: {}, deduped: false })) as never,
    push: vi.fn(),
  });
  const started = await holds.start({
    requester: { agentPath: '/agents/scout', name: 'Scout', sessionId: 'session-scout' },
    action: { actionName: 'Delete message', serviceName: 'Gmail' },
  });
  if (!started) throw new Error('The hold did not start.');
  ({ holdId, ended } = started);
  target.mount(
    honoGroupListener({ path: '/api/connectors', routes: createConnectorHoldRoutes({ holds }) })
  );
});

function cancel(id: string, headers: Record<string, string> = {}) {
  return request(target.server).post(`/api/connectors/holds/${id}/cancel`).set(headers).send({});
}

describe('POST /api/connectors/holds/:holdId/cancel', () => {
  it('lets a person cancel, and the action never runs', async () => {
    const res = await cancel(holdId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'cancelled', holdId });
    await expect(ended).resolves.toEqual({ outcome: 'cancelled', by: 'A person' });
  });

  it('lets another agent cancel, named as itself', async () => {
    const res = await cancel(holdId, { 'x-dorkos-agent': ATLAS_TOKEN });
    expect(res.status).toBe(200);
    await expect(ended).resolves.toEqual({ outcome: 'cancelled', by: 'Atlas' });
  });

  it('refuses the agent that asked for the action', async () => {
    const res = await cancel(holdId, { 'x-dorkos-agent': SCOUT_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'HOLD_REQUESTER' });
    // Still waiting: a person can still cancel it.
    expect(holds.cancel(holdId, { kind: 'person' })).toEqual({ ok: true });
  });

  it('answers 404 for an action that is not waiting', async () => {
    const res = await cancel('no-such-hold');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'HOLD_NOT_FOUND' });
  });
});
