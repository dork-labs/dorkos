import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';

// The boundary checks pass a path through unless a test makes one refuse; the
// real BoundaryError stays so a refusal has the right type.
vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
}));

// Stub the one destructive export and keep the rest real. A whole-module
// factory would blank `MANIFEST_DIR`/`MANIFEST_FILE` for every OTHER consumer
// that loads through this mock — including the mesh package's own git-tracked
// guard, which then builds `undefined` into a path and throws (DOR-1019).
vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
  removeDorkDirectory: vi.fn().mockResolvedValue(undefined),
}));

// The unregister route's orphan scan is a spy (the real one walks the
// filesystem), so a test can see it runs before unregister.
vi.mock('../../../services/mesh/orphaned-installs.js', () => ({
  logOrphanedInstalls: vi.fn().mockResolvedValue(undefined),
}));

import { validateBoundary, BoundaryError } from '../../../lib/boundary.js';
import { removeDorkDirectory } from '@dorkos/shared/manifest';
import { logOrphanedInstalls } from '../../../services/mesh/orphaned-installs.js';
import {
  createMockMeshCore,
  fixtureServer,
  MOCK_MANIFEST,
  mountMesh,
  useLoginOffConfig,
  useTempDirs,
  type MockMeshCore,
} from './mesh.fixtures.js';

useLoginOffConfig();
const tempDir = useTempDirs();

const outside = () =>
  new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');

let meshCore: MockMeshCore;

beforeEach(() => {
  vi.clearAllMocks();
  meshCore = createMockMeshCore();
  mountMesh(meshCore);
});

describe('DELETE /api/mesh/agents/:id', () => {
  it('surfaces orphaned installs BEFORE unregistering (path is gone after unregister)', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.getProjectPath.mockReturnValue('/home/user/project');

    const res = await request(fixtureServer).delete('/api/mesh/agents/agent-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, blockedFromDiscovery: false });
    expect(logOrphanedInstalls).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/home/user/project', agentLabel: 'Test Agent' })
    );
    // Ordering invariant: the scan must run while the agent is still
    // registered — unregister removes the registry entry, after which
    // getProjectPath returns undefined and the scan would find nothing.
    const scanOrder = vi.mocked(logOrphanedInstalls).mock.invocationCallOrder[0];
    const unregisterOrder = meshCore.unregister.mock.invocationCallOrder[0];
    expect(scanOrder).toBeLessThan(unregisterOrder);
  });

  it('skips the orphan scan when the agent has no resolvable project path', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);

    await request(fixtureServer).delete('/api/mesh/agents/agent-1');

    expect(logOrphanedInstalls).not.toHaveBeenCalled();
    expect(meshCore.unregister).toHaveBeenCalledWith('agent-1');
  });

  it('reports blockedFromDiscovery when unregister had to keep the manifest', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.unregister.mockResolvedValue({ manifestKept: true });

    const res = await request(fixtureServer).delete('/api/mesh/agents/agent-1');

    expect(res.status).toBe(200);
    // The app says so in the toast; without this the second effect is invisible.
    expect(res.body).toEqual({ success: true, blockedFromDiscovery: true });
  });
});

describe('DELETE /api/mesh/agents/:id/data', () => {
  /** Delete agent-1's data, and check nothing was removed when `refused`. */
  const deleteData = () => request(fixtureServer).delete('/api/mesh/agents/agent-1/data');
  const expectNothingRemoved = () => {
    expect(meshCore.unregister).not.toHaveBeenCalled();
    expect(removeDorkDirectory).not.toHaveBeenCalled();
  };

  it('returns 404 and removes nothing when the agent is not found', async () => {
    const res = await deleteData();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Agent not found');
    expectNothingRemoved();
  });

  it('returns 403 and removes nothing for a system agent', async () => {
    meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });

    const res = await deleteData();

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('System agents');
    expectNothingRemoved();
  });

  it('returns 403 and removes nothing when the project path is outside the boundary', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.getProjectPath.mockReturnValue('/etc/shadow');
    vi.mocked(validateBoundary).mockRejectedValueOnce(outside());

    const res = await deleteData();

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Path outside boundary');
    expectNothingRemoved();
  });

  it('returns 404 and removes nothing when the agent has no project path', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);

    const res = await deleteData();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Agent project path not found');
    expectNothingRemoved();
  });

  it('refuses to delete a .dork directory whose agent.json git tracks', async () => {
    // A real repo with a real committed manifest: the guard shells out to
    // git, so a fake path would only prove that git said "no repo here".
    const repo = await tempDir();
    const gitArgs = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    execFileSync('git', [...gitArgs, 'init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    await fs.mkdir(path.join(repo, '.dork'));
    await fs.writeFile(path.join(repo, '.dork', 'agent.json'), '{}', 'utf-8');
    execFileSync('git', [...gitArgs, 'add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', [...gitArgs, 'commit', '-q', '-m', 'manifest'], {
      cwd: repo,
      stdio: 'pipe',
    });
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.getProjectPath.mockReturnValue(repo);

    const res = await deleteData();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('agent.json');
    expect(res.body.error).toContain('tracked by git');
    expectNothingRemoved();
    expect(await fs.readFile(path.join(repo, '.dork', 'agent.json'), 'utf-8')).toBe('{}');
  });

  it('unregisters agent, deletes .dork directory, and returns success', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.getProjectPath.mockReturnValue('/home/user/project');

    const res = await deleteData();

    expect(res.status).toBe(200);
    expect(res.body.deletedPath).toBe('/home/user/project/.dork');
    expect(meshCore.unregister).toHaveBeenCalledWith('agent-1');
    expect(removeDorkDirectory).toHaveBeenCalledWith('/home/user/project');
  });
});

describe('POST /api/mesh/deny', () => {
  it('denies a path and returns 201', async () => {
    const res = await request(fixtureServer).post('/api/mesh/deny').send({
      path: '/home/user/bad-project',
      reason: 'Untrusted source',
      denier: 'admin',
    });

    expect(res.status).toBe(201);
    expect(meshCore.deny).toHaveBeenCalledWith(
      '/home/user/bad-project',
      'Untrusted source',
      'admin'
    );
  });

  it('returns 422 when deny throws', async () => {
    meshCore.deny.mockRejectedValue(new Error('Already denied'));

    const res = await request(fixtureServer)
      .post('/api/mesh/deny')
      .send({ path: '/home/user/bad-project' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Already denied');
  });
});

describe('DELETE /api/mesh/denied?path=', () => {
  const clear = (folder: string) =>
    request(fixtureServer).delete(`/api/mesh/denied?path=${encodeURIComponent(folder)}`);

  it.each(['/home/user/bad-project', '/home/user/my project (2)/agent', 'C:\\Users\\qa\\agent'])(
    'clears the denial of %s, read as written',
    async (folder) => {
      const res = await clear(folder);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(meshCore.undeny).toHaveBeenCalledWith(folder);
    }
  );

  // The folder arrives decoded, so the route's own checks are the only ones
  // between it and the denial list: they run exactly as they did on the path.
  it.each(['/home/user/../../etc', '/home/user/agent\0'])(
    'refuses %s with 400 before the boundary check',
    async (folder) => {
      const res = await clear(folder);
      expect(res.status).toBe(400);
      expect(validateBoundary).not.toHaveBeenCalled();
      expect(meshCore.undeny).not.toHaveBeenCalled();
    }
  );

  it.each(['/api/mesh/denied?path=', '/api/mesh/denied?path=%2Fa&path=%2Fb'])(
    'refuses %s with 400',
    async (target) => {
      const res = await request(fixtureServer).delete(target);
      expect(res.status).toBe(400);
      expect(meshCore.undeny).not.toHaveBeenCalled();
    }
  );
});

describe('agent health and heartbeat', () => {
  it('returns the health snapshot for an existing agent', async () => {
    meshCore.getAgentHealth.mockReturnValue({ agentId: 'agent-1', status: 'active' });

    const res = await request(fixtureServer).get('/api/mesh/agents/agent-1/health');

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe('agent-1');
    expect(meshCore.getAgentHealth).toHaveBeenCalledWith('agent-1');
  });

  it.each([
    [{ event: 'message_sent' }, 'message_sent'],
    [{}, 'heartbeat'],
  ])('records a heartbeat from %j as %s', async (body, event) => {
    meshCore.getAgentHealth.mockReturnValue({ agentId: 'agent-1', status: 'active' });

    const res = await request(fixtureServer).post('/api/mesh/agents/agent-1/heartbeat').send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(meshCore.updateLastSeen).toHaveBeenCalledWith('agent-1', event);
  });

  it('records nothing for an unknown agent', async () => {
    const res = await request(fixtureServer)
      .post('/api/mesh/agents/nonexistent/heartbeat')
      .send({ event: 'heartbeat' });

    expect(res.status).toBe(404);
    expect(meshCore.updateLastSeen).not.toHaveBeenCalled();
  });
});
