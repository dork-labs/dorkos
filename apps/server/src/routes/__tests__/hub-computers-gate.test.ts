/**
 * @vitest-environment node
 *
 * `/api/hub/computers` is the hub owner's alone: through the real `/api` chain
 * and session gate on a hub, a caller with no sign-in is refused before any
 * route runs, for reads, the stream, writes and the link routes alike, and
 * nothing reaches a computer.
 */
import { describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => 'hub' }));
// The front door is not what this file is about: it admits everything here.
vi.mock('../../services/core/hub/hub-serving.js', () => ({
  admitHubRequest: () => null,
  trackHubConnection: () => {},
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createHubComputerRoutes, type RelayedComputer } from '../hub-computers.js';

const computer = {
  connected: true,
  features: ['chats.list', 'session.stream', 'session.send', 'session.interrupt'],
  request: vi.fn(),
  openStream: vi.fn(),
};
const deps = {
  isHub: () => true,
  linkedComputerIds: () => ['computer-1'],
  connection: () => computer as unknown as RelayedComputer,
  wake: vi.fn(),
  viewers: { open: vi.fn(() => () => {}) },
};

const server = listeningServer(
  honoGroupListener({ path: '/api/hub/computers', routes: createHubComputerRoutes(deps) })
);

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = '/api/hub/computers/computer-1';

describe('the hub gate on /api/hub/computers', () => {
  it.each([
    ['get', '/api/hub/computers'],
    ['get', `${BASE}/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV/chats`],
    ['get', `${BASE}/sessions/${SESSION}/stream`],
    ['post', `${BASE}/sessions/${SESSION}/messages`],
    ['post', `${BASE}/sessions/${SESSION}/interrupt`],
    ['post', `${BASE}/sessions/${SESSION}/answers`],
    ['post', '/api/hub/computers/link-code'],
    ['delete', BASE],
  ] as const)('refuses %s %s without a sign-in', async (method, path) => {
    const res = await request(server)[method](path).set('Host', 'localhost:4242');
    expect(res.status).toBe(401);
    // The chain's own refusal, not the routes' second check behind it.
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(computer.request).not.toHaveBeenCalled();
    expect(computer.openStream).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});
