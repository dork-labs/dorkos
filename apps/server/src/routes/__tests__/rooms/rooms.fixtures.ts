/**
 * Shared setup for the `/api/rooms` route tests, driven through the REAL app
 * mount rather than a bespoke mini-router, so the route wiring and the
 * middleware stack in front of it are covered too.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { MainRequestAdmission } from '../../../services/core/lifecycle/main-request-admission.js';
import { composedListener } from '../../../http/__tests__/composed-listener.js';
import { createRoomSubsystem, setRoomService } from '../../../services/rooms/index.js';
import { setReadCursorService } from '../../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../services/core/agent-identity/agent-identity-service.js';
import { resetPermissionGate } from '../../../services/core/capabilities/index.js';
import { initBoundary } from '../../../lib/boundary.js';
import { initConfigManager } from '../../../services/core/config-manager.js';

// The server's real routing: `/api/read-cursors` and the rooms routes answer
// from the one app.
export const testServer = listeningServer(composedListener(new MainRequestAdmission()));

export const ANA_PATH = '/agents/ana';
export const BO_PATH = '/agents/bo';

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

/**
 * Give each test a fresh database with Ana and Bo registered, and a room
 * subsystem built on it.
 *
 * @returns A getter for the current test's database.
 */
export function useRoomsApp(): () => Db {
  let db: Db;
  let home: string;

  // The boundary is the filesystem root, so every made-up agent path is inside
  // it; the config store (login off) lives in a throwaway folder.
  beforeAll(async () => {
    await initBoundary('/');
    home = mkdtempSync(join(tmpdir(), 'dorkos-rooms-routes-'));
    initConfigManager(home);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  beforeEach(() => {
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    registerAgent(db, 'bo', BO_PATH);
    // Both halves of one subsystem: the rooms service and the read-cursor
    // service it writes a person's place into, so the room list and
    // `/api/read-cursors` provably read the same table.
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
  });

  afterEach(() => {
    resetAgentIdentityService();
    // A test may allow Rooms for every agent; cleared so it cannot leak.
    resetPermissionGate();
  });

  return () => db;
}

/** Create a channel and return its body. */
export async function createChannel(
  title = 'Backend'
): Promise<Record<string, never> & { id: string }> {
  const res = await request(testServer).post('/api/rooms').send({ kind: 'channel', title });
  expect(res.status).toBe(201);
  return res.body;
}

/** Mint an identity token for an agent, as the agent-identity header carries it. */
export async function agentToken(db: Db, agentPath: string, displayName: string): Promise<string> {
  return initAgentIdentityService(db).mint({ agentPath, displayName });
}

/** Add Ana to a room as the person, and return her token. */
export async function anaIn(db: Db, roomId: string): Promise<string> {
  const token = await agentToken(db, ANA_PATH, 'Ana');
  await request(testServer).post(`/api/rooms/${roomId}/members`).send({ agentPath: ANA_PATH });
  return token;
}
