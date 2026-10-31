/**
 * `GET /api/sessions/running` (DOR-3460): who the route reads as. The read
 * itself is under test in `services/session/running-chats/__tests__/running-chats.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

const listRunningChats = vi.fn();
vi.mock('../../services/session/running-chats/running-chats.js', () => ({
  listRunningChats: (...args: unknown[]) => listRunningChats(...args),
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => null), set: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createRunningChatsRoutes } from '../running-chats.js';

const EMPTY = { total: 0, agents: [], unassigned: { count: 0, privateCount: 0, chats: [] } };
const roster = { listWithPaths: () => [] } as never;

const target = swappableServer();

function listener() {
  return target.mount(
    honoGroupListener({
      path: '/api/sessions/running',
      routes: createRunningChatsRoutes({ meshCore: roster }),
    })
  );
}

describe('GET /api/sessions/running', () => {
  beforeEach(() => {
    listRunningChats.mockReset();
    listRunningChats.mockResolvedValue(EMPTY);
  });

  it('reads as the owner for a person, and answers the read', async () => {
    const response = await request(listener()).get('/api/sessions/running');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(EMPTY);
    expect(listRunningChats).toHaveBeenCalledWith(roster, { kind: 'owner' });
  });

  it('reads as an agent for a caller presenting an agent header it cannot name', async () => {
    const response = await request(listener())
      .get('/api/sessions/running')
      .set('X-DorkOS-Agent', 'nobody');

    expect(response.status).toBe(200);
    expect(listRunningChats).toHaveBeenCalledWith(roster, {
      kind: 'agent',
      accountId: 'unidentified',
    });
  });
});
