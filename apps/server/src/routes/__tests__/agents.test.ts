import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

const mockReadManifest = vi.fn();
const mockWriteManifest = vi.fn();

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: (...args: unknown[]) => mockReadManifest(...args),
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
  MANIFEST_DIR: '.dork',
}));

const mockReadConventionFile = vi.fn().mockResolvedValue(null);
const mockWriteConventionFile = vi.fn().mockResolvedValue(undefined);

vi.mock('@dorkos/shared/convention-files', () => ({
  readConventionFile: (...args: unknown[]) => mockReadConventionFile(...args),
  writeConventionFile: (...args: unknown[]) => mockWriteConventionFile(...args),
  buildSoulContent: vi.fn(
    (traitBlock: string, prose: string) =>
      `<!-- TRAITS:START -->\n${traitBlock}\n<!-- TRAITS:END -->\n\n${prose}`
  ),
  defaultSoulTemplate: vi.fn(
    (name: string) => `<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\n\nYou are ${name}`
  ),
  defaultNopeTemplate: vi.fn(() => '# Safety Boundaries'),
}));

vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: (...args: unknown[]) => mockReadConventionFile(...args),
  writeConventionFile: (...args: unknown[]) => mockWriteConventionFile(...args),
}));

vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => 'rendered-traits'),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
}));

vi.mock('ulidx', () => ({
  ulid: vi.fn(() => 'MOCK_ULID_001'),
}));

vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: vi.fn(() => '# DorkBot\n\nYou are DorkBot.'),
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => {
      if (key === 'agents') return { defaultDirectory: '/mock/agents', defaultAgent: 'dorkbot' };
      return undefined;
    }),
    set: vi.fn(),
    getAll: vi.fn(),
  },
}));

import request from 'supertest';
import express from 'express';
import { createAgentsRouter } from '../agents.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// Build a minimal Express app with just the agents router
const app = express();
app.use(express.json());
app.use('/api/agents', createAgentsRouter());

const mockManifest: AgentManifest = {
  id: 'test-agent-id',
  name: 'test-agent',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: ['code-review'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00.000Z',
  registeredBy: 'dorkos-ui',
  personaEnabled: true,
};

describe('Agents Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadManifest.mockResolvedValue(null);
    mockWriteManifest.mockResolvedValue(undefined);
  });

  describe('GET /api/agents/current', () => {
    it('returns 400 when path query is missing', async () => {
      const res = await request(app).get('/api/agents/current');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('path query parameter required');
    });

    it('returns 404 when no manifest found', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No agent registered at this path');
    });

    it('returns 200 with manifest when found', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('test-agent-id');
      expect(res.body.name).toBe('test-agent');
    });

    it('validates boundary and returns 403 for out-of-bounds path', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/agents/current').query({ path: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('POST /api/agents/resolve', () => {
    it('returns agents map for mixed registered/unregistered paths', async () => {
      mockReadManifest.mockResolvedValueOnce(mockManifest).mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/agents/resolve')
        .send({ paths: ['/home/user/project-a', '/home/user/project-b'] });

      expect(res.status).toBe(200);
      expect(res.body.agents['/home/user/project-a']).toBeTruthy();
      expect(res.body.agents['/home/user/project-a'].id).toBe('test-agent-id');
      expect(res.body.agents['/home/user/project-b']).toBeNull();
    });

    it('returns 400 for invalid request body', async () => {
      const res = await request(app).post('/api/agents/resolve').send({ paths: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when paths is not an array', async () => {
      const res = await request(app).post('/api/agents/resolve').send({ paths: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('sets null for paths that fail boundary validation', async () => {
      vi.mocked(validateBoundary)
        .mockResolvedValueOnce('/home/user/good-path')
        .mockRejectedValueOnce(
          new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
        );

      mockReadManifest.mockResolvedValueOnce(mockManifest);

      const res = await request(app)
        .post('/api/agents/resolve')
        .send({ paths: ['/home/user/good-path', '/etc/shadow'] });

      expect(res.status).toBe(200);
      expect(res.body.agents['/home/user/good-path']).toBeTruthy();
      expect(res.body.agents['/etc/shadow']).toBeNull();
    });
  });

  describe('POST /api/agents', () => {
    it('creates agent with defaults (name from basename, ULID id)', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(app).post('/api/agents').send({ path: '/home/user/my-project' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('MOCK_ULID_001');
      expect(res.body.name).toBe('my-project');
      expect(res.body.runtime).toBe('claude-code');
      expect(res.body.registeredBy).toBe('dorkos-ui');
      expect(res.body.personaEnabled).toBe(true);
      expect(mockWriteManifest).toHaveBeenCalledWith(
        '/home/user/my-project',
        expect.objectContaining({
          id: 'MOCK_ULID_001',
          name: 'my-project',
        })
      );
    });

    it('creates agent with provided name and description', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents')
        .send({ path: '/home/user/my-project', name: 'Custom Agent', description: 'Does things' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Custom Agent');
      expect(res.body.description).toBe('Does things');
    });

    it('returns 409 when agent already exists', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app).post('/api/agents').send({ path: '/home/user/project' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Agent already exists at this path');
      expect(res.body.agent.id).toBe('test-agent-id');
    });

    it('returns 400 for missing path', async () => {
      const res = await request(app).post('/api/agents').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('validates boundary and returns 403 for out-of-bounds path', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).post('/api/agents').send({ path: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('PATCH /api/agents/current', () => {
    it('returns 400 when path query is missing', async () => {
      const res = await request(app).patch('/api/agents/current').send({ name: 'new-name' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('path query parameter required');
    });

    it('returns 404 for unregistered path', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ name: 'new-name' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No agent registered at this path');
    });

    it('merges updates into existing manifest', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ displayName: 'Updated Name', description: 'new description' });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Updated Name');
      expect(res.body.description).toBe('new description');
      // Unchanged fields preserved
      expect(res.body.id).toBe('test-agent-id');
      expect(res.body.runtime).toBe('claude-code');
      expect(mockWriteManifest).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({
          id: 'test-agent-id',
          displayName: 'Updated Name',
          description: 'new description',
        })
      );
    });

    it('updates persona fields', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ persona: 'You are an API expert', personaEnabled: true });

      expect(res.status).toBe(200);
      expect(res.body.persona).toBe('You are an API expert');
      expect(res.body.personaEnabled).toBe(true);
    });

    it('validates boundary and returns 403 for out-of-bounds path', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/etc/shadow' })
        .send({ name: 'hacker' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('returns 400 for invalid update body', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      // The UpdateAgentRequestSchema should reject unknown fields
      // but since it's a partial schema, empty body should be fine
      // Test with a persona that's too long (>4000 chars)
      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ persona: 'x'.repeat(4001) });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 403 when modifying protected fields on a system agent', async () => {
      mockReadManifest.mockResolvedValue({ ...mockManifest, isSystem: true });

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ displayName: 'Hacked Name', description: 'Hacked Desc' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('displayName');
      expect(res.body.error).toContain('description');
      expect(res.body.error).toContain('system agents');
      expect(mockWriteManifest).not.toHaveBeenCalled();
    });

    it('returns 403 when modifying namespace on a system agent', async () => {
      mockReadManifest.mockResolvedValue({ ...mockManifest, isSystem: true });

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ namespace: 'evil-ns' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('namespace');
    });

    it('returns 403 when modifying isSystem on a system agent', async () => {
      mockReadManifest.mockResolvedValue({ ...mockManifest, isSystem: true });

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ isSystem: false });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('isSystem');
    });

    it('allows non-protected fields on a system agent', async () => {
      const systemManifest = { ...mockManifest, isSystem: true };
      mockReadManifest.mockResolvedValue(systemManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ persona: 'You are helpful', personaEnabled: true });

      expect(res.status).toBe(200);
      expect(res.body.persona).toBe('You are helpful');
      expect(mockWriteManifest).toHaveBeenCalled();
    });

    it('allows protected fields on a non-system agent', async () => {
      mockReadManifest.mockResolvedValue({ ...mockManifest, isSystem: false });

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ displayName: 'New Display Name' });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('New Display Name');
      expect(mockWriteManifest).toHaveBeenCalled();
    });

    it('rejects name mutation (slug is immutable)', async () => {
      mockReadManifest.mockResolvedValue({ ...mockManifest, isSystem: false });

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ name: 'new-slug' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('displayName');
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-0043: MeshCore sync integration
// ---------------------------------------------------------------------------

describe('Agents Routes with MeshCore (ADR-0043)', () => {
  const mockSyncFromDisk = vi.fn().mockResolvedValue(true);
  const mockMeshCore = { syncFromDisk: mockSyncFromDisk };

  const appWithMesh = express();
  appWithMesh.use(express.json());
  appWithMesh.use('/api/agents', createAgentsRouter(mockMeshCore));

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadManifest.mockResolvedValue(null);
    mockWriteManifest.mockResolvedValue(undefined);
  });

  it('POST calls syncFromDisk after creating agent', async () => {
    const res = await request(appWithMesh)
      .post('/api/agents')
      .send({ path: '/home/user/new-project' });

    expect(res.status).toBe(201);
    expect(mockSyncFromDisk).toHaveBeenCalledWith('/home/user/new-project');
  });

  it('PATCH calls syncFromDisk after updating agent', async () => {
    mockReadManifest.mockResolvedValue(mockManifest);

    const res = await request(appWithMesh)
      .patch('/api/agents/current')
      .query({ path: '/home/user/project' })
      .send({ displayName: 'Synced Name' });

    expect(res.status).toBe(200);
    expect(mockSyncFromDisk).toHaveBeenCalledWith('/home/user/project');
  });

  it('POST succeeds even if syncFromDisk fails', async () => {
    mockSyncFromDisk.mockRejectedValueOnce(new Error('sync failed'));

    const res = await request(appWithMesh)
      .post('/api/agents')
      .send({ path: '/home/user/failing-sync' });

    expect(res.status).toBe(201);
  });

  it('PATCH succeeds even if syncFromDisk fails', async () => {
    mockReadManifest.mockResolvedValue(mockManifest);
    mockSyncFromDisk.mockRejectedValueOnce(new Error('sync failed'));

    const res = await request(appWithMesh)
      .patch('/api/agents/current')
      .query({ path: '/home/user/project' })
      .send({ displayName: 'Still Works' });

    expect(res.status).toBe(200);
  });
});
