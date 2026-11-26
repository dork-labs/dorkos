/**
 * `GET /api/sessions/running` (DOR-3460), served by the capability mount from
 * `audit.running_chats`: who the route reads as. The read itself is under test
 * in `services/session/running-chats/__tests__/running-chats.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { SessionStatus } from '@dorkos/shared/session-stream';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => null), set: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import { auditDomain } from '../../services/audit/audit-capabilities.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import type { RunningChatSources } from '../../services/session/chat-messages/screen/running-chats.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';

/** One live chat nobody's agent is bound to. */
const runningChatSources: RunningChatSources = {
  statuses: () => [
    {
      sessionId: 'chat-1',
      cwd: '/projects/scratch',
      status: { lifecycle: 'streaming' } as unknown as SessionStatus,
    },
  ],
  needsYou: () => false,
  agentPathOf: async () => null,
  titleOf: async () => 'Plan the launch',
  starterOf: () => null,
};

const target = swappableServer();

function listener() {
  const registry = composeRegistry([auditDomain], {
    logger: noopLogger,
    auditDeps: { log: new AuditLog(createTestDb()), runningChatSources },
  });
  return target.mount(
    honoGroupListener({
      path: '/',
      routes: createCapabilityHttpRoutes({
        registry: () => registry,
        capabilities: auditDomain.capabilities,
      }),
    })
  );
}

describe('GET /api/sessions/running', () => {
  it('reads as the owner for a person, who sees the chat by name', async () => {
    const response = await request(listener()).get('/api/sessions/running');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      agents: [],
      unassigned: {
        count: 1,
        privateCount: 0,
        chats: [expect.objectContaining({ id: 'chat-1', title: 'Plan the launch' })],
      },
    });
  });

  it('reads as an agent for a caller presenting an agent header it cannot name', async () => {
    const response = await request(listener())
      .get('/api/sessions/running')
      .set('X-DorkOS-Agent', 'nobody');

    // An agent never reads a chat nobody said it may: counted, never named.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      unassigned: { count: 1, privateCount: 1, chats: [] },
    });
    expect(JSON.stringify(response.body)).not.toContain('Plan the launch');
  });
});
