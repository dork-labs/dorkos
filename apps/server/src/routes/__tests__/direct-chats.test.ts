import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * `POST /api/direct-chats` — open an agent's Direct chat (rule S12, DOR-2997),
 * driven through the real app mount so the caller seam in front of it counts.
 *
 * Seeded defects, each red before the fix:
 *
 * - Dropping the owner gate turns "refuses an agent" red: the agent got a 200.
 * - Answering any DM in `ensureForRoom` turns "refuses a group DM" red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { composedListener } from '../../http/__tests__/composed-listener.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { wireDirectChats } from '../../services/rooms/direct-chat/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const admission = new MainRequestAdmission();
const server = listeningServer(composedListener(admission));

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('POST /api/direct-chats', () => {
  let db: Db;

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    registerAgent(db, 'bo', BO_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    wireDirectChats({ store: rooms.store, authors: rooms.authors, rooms: rooms.service });
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  async function dm(agentPaths: string[]): Promise<string> {
    const created = await request(server)
      .post('/api/rooms')
      .send({ kind: 'dm', title: 'DM', agentPaths });
    expect([200, 201]).toContain(created.status);
    return created.body.id;
  }

  it('opens the Direct chat a one-agent DM is, the same one every time', async () => {
    const roomId = await dm([ANA_PATH]);

    const first = await request(server).post('/api/direct-chats').send({ roomId });
    const again = await request(server).post('/api/direct-chats').send({ roomId });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ roomId, agentPath: ANA_PATH });
    expect(typeof first.body.sessionId).toBe('string');
    expect(again.body).toEqual(first.body);
  });

  it('refuses a group DM, which opens as a room', async () => {
    const roomId = await dm([ANA_PATH, BO_PATH]);

    const res = await request(server).post('/api/direct-chats').send({ roomId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_A_DIRECT_CHAT');
  });

  it('refuses an agent: a Direct chat is the owner’s own conversation', async () => {
    const roomId = await dm([ANA_PATH]);
    const token = await initAgentIdentityService(db).mint({
      agentPath: ANA_PATH,
      displayName: 'Ana',
    });

    const res = await request(server)
      .post('/api/direct-chats')
      .set('X-DorkOS-Agent', token)
      .send({ roomId });

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('sessionId');
  });

  it('refuses a body that names neither an agent nor a room', async () => {
    const res = await request(server).post('/api/direct-chats').send({ agentPath: ANA_PATH });

    expect(res.status).toBe(400);
  });
});
