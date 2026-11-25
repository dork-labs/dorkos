/**
 * Shared fakes for the Mesh route tests: a mocked MeshCore, the routes (and
 * the step-up routes a login-on change waits on) behind the real `/api` chain,
 * one swappable listener per test file, and the real config manager in its
 * default login-off posture with a real owner account.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, vi, type Mock } from 'vitest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { MeshCore } from '@dorkos/mesh';
import { createStepUpRoutes } from '../../step-up.js';
import { createMeshRoutes } from '../../mesh.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
import { capabilityGroup } from '../../../http/__tests__/capability-group.js';
import { meshDomain } from '../../../services/mesh/doors/mesh-capabilities.js';
import type { ActivityService } from '../../../services/activity/activity-service.js';
import { initConfigManager } from '../../../services/core/config-manager.js';

/** ONE listener per test file, with the app behind it swapped per test. */
export const fixtureTarget = swappableServer();
/** The listening server every request in a file goes to. */
export const fixtureServer = fixtureTarget.server;

/** Create a mock MeshCore with vi.fn() stubs for all methods. */
export function createMockMeshCore(): MockMeshCore {
  return {
    discover: vi.fn(),
    register: vi.fn(),
    registerByPath: vi.fn(),
    deny: vi.fn().mockResolvedValue(undefined),
    undeny: vi.fn().mockResolvedValue(undefined),
    // Mirrors the real `MeshCore.unregister`, which reports whether it had to
    // leave a git-tracked manifest on disk (DOR-1019).
    unregister: vi.fn().mockResolvedValue({ manifestKept: false }),
    list: vi.fn().mockReturnValue([]),
    listWithHealth: vi.fn().mockReturnValue([]),
    listWithPaths: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    listDenied: vi.fn().mockReturnValue([]),
    update: vi.fn().mockReturnValue(undefined),
    getStatus: vi.fn(),
    getAgentHealth: vi.fn().mockReturnValue(undefined),
    getProjectPath: vi.fn().mockReturnValue(undefined),
    updateLastSeen: vi.fn(),
    close: vi.fn(),
  };
}

/** The mock MeshCore {@link createMockMeshCore} returns: each method a bare `vi.fn()`. */
export type MockMeshCore = Record<
  | 'discover'
  | 'register'
  | 'registerByPath'
  | 'deny'
  | 'undeny'
  | 'unregister'
  | 'list'
  | 'listWithHealth'
  | 'listWithPaths'
  | 'get'
  | 'listDenied'
  | 'update'
  | 'getStatus'
  | 'getAgentHealth'
  | 'getProjectPath'
  | 'updateLastSeen'
  | 'close',
  Mock
>;

/** One registered agent's manifest. */
export const MOCK_MANIFEST = {
  id: 'agent-1',
  name: 'Test Agent',
  description: 'A test agent',
  runtime: 'claude-code' as const,
  capabilities: ['code'],
  projectPath: '/home/user/project',
  behavior: { responseMode: 'always' },
  registeredAt: '2026-02-25T00:00:00Z',
  registeredBy: 'user',
};

/**
 * Serve the mesh routes behind the `/api` chain, recording into `activity` if
 * given: the capability mount's doors first, as the app mounts them, then the
 * two hand routes.
 */
export function mountMesh(meshCore: MockMeshCore, activity?: ActivityService): void {
  const meshDeps = { meshCore: meshCore as unknown as MeshCore, ...(activity && { activity }) };
  fixtureTarget.mount(
    honoGroupListener([
      capabilityGroup(meshDomain, { meshDeps }),
      {
        path: '/api/mesh',
        routes: createMeshRoutes({ meshCore: meshCore as unknown as MeshCore, activity }),
      },
      {
        path: '/api/step-up',
        routes: createStepUpRoutes({
          ownerId: () => 'user_owner',
          checkPassword: async (password) => (password === 'made-up-password' ? 'ok' : 'wrong'),
          minPasswordLength: async () => 8,
          setOwnerPassword: async () => undefined,
          trustedOrigins: () => ['http://localhost:4242'],
        }),
      },
    ])
  );
}

/** Run the file against the real config manager, login off (the default). */
export function useLoginOffConfig(): void {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-mesh-routes-'));
    initConfigManager(home);
  });
  afterAll(() => fs.rm(home, { recursive: true, force: true }));
}

/** Make a real directory removed after the test; returns its real path. */
export function useTempDirs(): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });
  return async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-route-')));
    dirs.push(dir);
    return dir;
  };
}
