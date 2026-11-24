import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';

// The boundary checks pass a path through unless a test makes one refuse; the
// real BoundaryError stays so a refusal has the right type.
vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

import {
  validateBoundary,
  validateBoundaryOrDorkHome,
  BoundaryError,
} from '../../../lib/boundary.js';
import type { ActivityService } from '../../../services/activity/activity-service.js';
import { setOnAgentCreated } from '../../../services/core/agent-created-hook.js';
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

/** Register `/home/user/project` with `overrides` and anything else in `extra`. */
const register = (overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  request(fixtureServer)
    .post('/api/mesh/agents')
    .send({ path: '/home/user/project', overrides, ...extra });

const BASIC = { name: 'test-agent', runtime: 'claude-code' };

let meshCore: MockMeshCore;

beforeEach(() => {
  vi.clearAllMocks();
  meshCore = createMockMeshCore();
  meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);
  mountMesh(meshCore);
});

describe('POST /api/mesh/discover', () => {
  it('returns discovered candidates, passing maxDepth through', async () => {
    const candidates = [
      { projectPath: '/home/user/proj-a', suggestedName: 'proj-a', detectedRuntime: 'claude-code' },
      { projectPath: '/home/user/proj-b', suggestedName: 'proj-b', detectedRuntime: 'cursor' },
    ];
    meshCore.discover.mockImplementation(async function* () {
      for (const c of candidates) yield { type: 'candidate', data: c };
    });

    const res = await request(fixtureServer)
      .post('/api/mesh/discover')
      .send({ roots: ['/home/user'], maxDepth: 3 });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual(candidates);
    expect(meshCore.discover).toHaveBeenCalledWith(['/home/user'], { maxDepth: 3 });
  });

  it('returns 400 when roots is empty array', async () => {
    const res = await request(fixtureServer).post('/api/mesh/discover').send({ roots: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('returns 500 when discovery throws', async () => {
    meshCore.discover.mockImplementation(async function* () {
      throw new Error('Permission denied');
    });

    const res = await request(fixtureServer)
      .post('/api/mesh/discover')
      .send({ roots: ['/root/secret'] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Permission denied');
  });

  it('validates every root and refuses if any one is outside the boundary', async () => {
    vi.mocked(validateBoundary)
      .mockResolvedValueOnce('/home/user/good')
      .mockRejectedValueOnce(outside());

    const res = await request(fixtureServer)
      .post('/api/mesh/discover')
      .send({ roots: ['/home/user/good', '/outside/boundary'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('/outside/boundary');
    expect(meshCore.discover).not.toHaveBeenCalled();
  });
});

describe('POST /api/mesh/agents', () => {
  it('registers an agent and returns 201', async () => {
    const res = await register(BASIC);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('agent-1');
    expect(meshCore.registerByPath).toHaveBeenCalledWith(
      '/home/user/project',
      expect.objectContaining(BASIC),
      undefined,
      undefined
    );
  });

  // ADR-0032: a validated scan root rides through as the fourth argument, and
  // may be the project itself.
  it.each([
    [{ approver: 'admin-user' }, '/home/user/project', 'admin-user', undefined],
    [
      { path: '/home/user/projects/dorkos/core', scanRoot: '/home/user/projects' },
      '/home/user/projects/dorkos/core',
      undefined,
      '/home/user/projects',
    ],
    [{ scanRoot: '/home/user/project' }, '/home/user/project', undefined, '/home/user/project'],
  ])('passes %j through to registerByPath', async (extra, agentPath, approver, scanRoot) => {
    const res = await register(BASIC, extra);

    expect(res.status).toBe(201);
    expect(meshCore.registerByPath).toHaveBeenCalledWith(
      agentPath,
      expect.objectContaining(BASIC),
      approver,
      scanRoot
    );
  });

  it('never takes reportsTo or createdBy from the body (DOR-2788)', async () => {
    // reportsTo is set only through a write surface that refuses a loop, and
    // createdBy is the account making the request.
    await register({ ...BASIC, reportsTo: 'agent-2', createdBy: 'forged' });

    const fields = meshCore.registerByPath.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('reportsTo');
    expect(fields.createdBy).not.toBe('forged');
  });

  // DOR-2054. This route is open to agents by its own comment, and it handed
  // `overrides` to `registerByPath` untouched: a display-style name became the
  // immutable slug, and a colour that is not a colour was written to disk.
  describe('identity fields', () => {
    it('slugifies a display-style name and keeps the original as the display name', async () => {
      const res = await register({ name: 'DorkOS Cloud', runtime: 'claude-code' });

      expect(res.status).toBe(201);
      expect(meshCore.registerByPath.mock.calls[0][1]).toMatchObject({
        name: 'dorkos-cloud',
        displayName: 'DorkOS Cloud',
      });
    });

    it.each(['144mono', '144x.co', 'doriancollier.com', 'next_starter', '日本語'])(
      'leaves the address %s exactly as it came',
      async (name) => {
        // The Discovery view sends the directory basename AS `overrides.name`
        // (`buildRegistrationOverrides` → `candidate.hints.suggestedName`), so
        // this is the door those measured addresses actually arrive at.
        await register({ name, runtime: 'claude-code' });

        const partial = meshCore.registerByPath.mock.calls[0][1] as Record<string, unknown>;
        expect(partial.name).toBe(name);
        expect(partial).not.toHaveProperty('displayName');
      }
    );

    it('stores a face in the one spelling the picker can match', async () => {
      await register({ ...BASIC, color: '  #ABC  ', icon: ' 🔮 ' });

      expect(meshCore.registerByPath.mock.calls[0][1]).toMatchObject({
        color: '#aabbcc',
        icon: '🔮',
      });
    });

    it.each([
      [{ color: 'pinkish' }, 'INVALID_COLOR'],
      [{ icon: 'sparkles' }, 'INVALID_ICON'],
    ])('refuses %j with 400 and never registers', async (face, code) => {
      const res = await register({ ...BASIC, ...face });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(meshCore.registerByPath).not.toHaveBeenCalled();
    });

    it('registers a bare { path } that already has a manifest, inventing no name (DOR-1019)', async () => {
      // The "Undo" on an unregister toast sends a bare `{ path }`; requiring a
      // name and runtime 400'd that recovery. Nothing may be named into it
      // either: adoption ignores every override, and a slug conjured from the
      // directory would be a lie if it ever landed.
      const dir = await tempDir();
      await fs.mkdir(path.join(dir, '.dork'));
      await fs.writeFile(
        path.join(dir, '.dork', 'agent.json'),
        JSON.stringify({ ...MOCK_MANIFEST, id: '01ANA0000000000000000000B' }),
        'utf-8'
      );

      const res = await request(fixtureServer).post('/api/mesh/agents').send({ path: dir });

      expect(res.status).toBe(201);
      const partial = meshCore.registerByPath.mock.calls[0][1] as Record<string, unknown>;
      expect(partial).not.toHaveProperty('name');
      expect(partial).not.toHaveProperty('displayName');
    });
  });

  it('returns 403 when the scan root is outside the boundary', async () => {
    // Register uses the dork-home seam for both the agent path (first call) and
    // the scan root (second call). Agent-path validation passes; scan-root rejects.
    vi.mocked(validateBoundaryOrDorkHome)
      .mockImplementationOnce(async (p: string) => p)
      .mockRejectedValueOnce(outside());

    const res = await register(BASIC, { scanRoot: '/etc' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Scan root outside boundary');
    expect(meshCore.registerByPath).not.toHaveBeenCalled();
  });

  it.each([{ runtime: 'claude-code' }, { name: 'test-agent' }])(
    'refuses a new folder with only %j',
    async (overrides) => {
      const res = await register(overrides);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overrides.name and overrides.runtime are required');
    }
  );

  it('returns 422 when registerByPath throws', async () => {
    meshCore.registerByPath.mockRejectedValue(new Error('Duplicate agent'));

    const res = await register(BASIC);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Duplicate agent');
  });
});

// --- The agent-created seam on the mesh register route (DOR-1042) ---

describe('agent-created seam (POST /api/mesh/agents)', () => {
  afterEach(() => {
    setOnAgentCreated(null);
  });

  it('notifies the seam after a successful registration, so the agent takes its #team seat now', async () => {
    const listener = vi.fn().mockResolvedValue(undefined);
    setOnAgentCreated(listener);
    meshCore.registerByPath.mockResolvedValue({ ...MOCK_MANIFEST, displayName: 'Testy' });

    const res = await register(BASIC);

    expect(res.status).toBe(201);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      id: 'agent-1',
      name: 'Test Agent',
      displayName: 'Testy',
      // The validated directory rides along: the rooms domain keys on it.
      path: '/home/user/project',
      // Registration, not creation — it takes the #team seat, but it is not
      // announced as a moment (DOR-1042).
      origin: 'registered',
    });
  });

  it('still returns 201 when the seam listener throws (never-500 guarantee)', async () => {
    setOnAgentCreated(vi.fn().mockRejectedValue(new Error('team seat exploded')));

    const res = await register(BASIC);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('agent-1');
  });

  it('seats the agent even when the activity write fails', async () => {
    // The activity feed is bookkeeping; the #team seat is the thing a person
    // sees. A failed feed write must not cost the seat, and must not turn a
    // registration that genuinely happened into a 422.
    const listener = vi.fn().mockResolvedValue(undefined);
    setOnAgentCreated(listener);
    mountMesh(meshCore, {
      emit: vi.fn().mockRejectedValue(new Error('activity store is down')),
    } as unknown as ActivityService);

    const res = await register(BASIC);

    expect(res.status).toBe(201);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify the seam when registration fails', async () => {
    const listener = vi.fn().mockResolvedValue(undefined);
    setOnAgentCreated(listener);
    meshCore.registerByPath.mockRejectedValue(new Error('Duplicate agent'));

    const res = await register(BASIC);

    expect(res.status).toBe(422);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('GET /api/mesh/agents', () => {
  it('returns agent list with health', async () => {
    meshCore.listWithHealth.mockReturnValue([MOCK_MANIFEST]);

    const res = await request(fixtureServer).get('/api/mesh/agents');

    expect(res.status).toBe(200);
    expect(res.body.agents[0].id).toBe('agent-1');
    expect(meshCore.listWithHealth).toHaveBeenCalledWith({});
  });

  it.each([
    ['runtime', 'cursor'],
    ['capability', 'code'],
  ])('passes the %s filter', async (key, value) => {
    await request(fixtureServer).get(`/api/mesh/agents?${key}=${value}`);

    expect(meshCore.listWithHealth).toHaveBeenCalledWith(expect.objectContaining({ [key]: value }));
  });

  it('returns one agent when found', async () => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);

    const res = await request(fixtureServer).get('/api/mesh/agents/agent-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('agent-1');
    expect(meshCore.get).toHaveBeenCalledWith('agent-1');
  });
});
