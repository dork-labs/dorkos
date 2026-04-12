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
}));

const mockReadConventionFile = vi.fn();
const mockWriteConventionFile = vi.fn();
const mockBuildSoulContent = vi.fn();
const mockDefaultSoulTemplate = vi.fn();
const mockDefaultNopeTemplate = vi.fn();

vi.mock('@dorkos/shared/convention-files', () => ({
  buildSoulContent: (...args: unknown[]) => mockBuildSoulContent(...args),
  defaultSoulTemplate: (...args: unknown[]) => mockDefaultSoulTemplate(...args),
  defaultNopeTemplate: (...args: unknown[]) => mockDefaultNopeTemplate(...args),
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: (...args: unknown[]) => mockReadConventionFile(...args),
  writeConventionFile: (...args: unknown[]) => mockWriteConventionFile(...args),
}));

const mockRenderTraits = vi.fn();

vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: (...args: unknown[]) => mockRenderTraits(...args),
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
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const app = express();
app.use(express.json());
app.use('/api/agents', createAgentsRouter());

const mockManifest: AgentManifest = {
  id: 'test-agent-id',
  name: 'test-agent',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00.000Z',
  registeredBy: 'dorkos-ui',
  personaEnabled: true,
};

describe('Agent Convention File Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadManifest.mockResolvedValue(null);
    mockWriteManifest.mockResolvedValue(undefined);
    mockReadConventionFile.mockResolvedValue(null);
    mockWriteConventionFile.mockResolvedValue(undefined);
    mockRenderTraits.mockReturnValue('rendered-traits');
    mockDefaultSoulTemplate.mockReturnValue('default-soul-content');
    mockDefaultNopeTemplate.mockReturnValue('# Safety Boundaries');
    mockBuildSoulContent.mockImplementation(
      (traitBlock: string, prose: string) =>
        `<!-- TRAITS:START -->\n${traitBlock}\n<!-- TRAITS:END -->\n\n${prose}`
    );
  });

  describe('POST /api/agents (convention file scaffolding)', () => {
    it('scaffolds SOUL.md with default template on agent creation', async () => {
      const res = await request(app).post('/api/agents').send({ path: '/home/user/project' });

      expect(res.status).toBe(201);
      expect(mockDefaultSoulTemplate).toHaveBeenCalledWith('project', 'rendered-traits');
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        'default-soul-content'
      );
    });

    it('scaffolds NOPE.md with default template on agent creation', async () => {
      const res = await request(app).post('/api/agents').send({ path: '/home/user/project' });

      expect(res.status).toBe(201);
      expect(mockDefaultNopeTemplate).toHaveBeenCalled();
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        '# Safety Boundaries'
      );
    });

    it('renders traits with DEFAULT_TRAITS for scaffolding', async () => {
      await request(app).post('/api/agents').send({ path: '/home/user/project' });

      expect(mockRenderTraits).toHaveBeenCalledWith({
        tone: 3,
        autonomy: 3,
        caution: 3,
        communication: 3,
        creativity: 3,
      });
    });

    it('uses provided agent name in soul template', async () => {
      await request(app)
        .post('/api/agents')
        .send({ path: '/home/user/project', name: 'My Custom Agent' });

      expect(mockDefaultSoulTemplate).toHaveBeenCalledWith('My Custom Agent', 'rendered-traits');
    });
  });

  describe('GET /api/agents/current (convention file contents)', () => {
    it('returns soulContent and nopeContent alongside manifest', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);
      mockReadConventionFile.mockImplementation(async (_path: string, filename: string) => {
        if (filename === 'SOUL.md') return '## Identity\nI am test-agent.';
        if (filename === 'NOPE.md') return '# Safety Boundaries\n## Never Do';
        return null;
      });

      const res = await request(app)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.soulContent).toBe('## Identity\nI am test-agent.');
      expect(res.body.nopeContent).toBe('# Safety Boundaries\n## Never Do');
      expect(res.body.id).toBe('test-agent-id');
    });

    it('returns null for missing convention files', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);
      mockReadConventionFile.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.soulContent).toBeNull();
      expect(res.body.nopeContent).toBeNull();
    });
  });

  describe('PATCH /api/agents/current (convention file writes)', () => {
    it('writes SOUL.md when soulContent is provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ soulContent: '## My custom soul' });

      expect(res.status).toBe(200);
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        '## My custom soul'
      );
    });

    it('writes NOPE.md when nopeContent is provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ nopeContent: '# Custom safety rules' });

      expect(res.status).toBe(200);
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        '# Custom safety rules'
      );
    });

    it('updates traits in agent.json manifest', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const traits = { tone: 1, autonomy: 5, caution: 3, communication: 3, creativity: 3 };
      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ traits });

      expect(res.status).toBe(200);
      expect(mockWriteManifest).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({ traits })
      );
      expect(res.body.traits).toEqual(traits);
    });

    it('updates conventions toggles in agent.json manifest', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const conventions = { soul: true, nope: false };
      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ conventions });

      expect(res.status).toBe(200);
      expect(mockWriteManifest).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({
          conventions: expect.objectContaining({ soul: true, nope: false }),
        })
      );
      expect(res.body.conventions).toEqual(expect.objectContaining({ soul: true, nope: false }));
    });

    it('does not write convention files when content is not provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ name: 'updated-name' });

      expect(mockWriteConventionFile).not.toHaveBeenCalled();
    });

    it('handles both manifest and convention file updates in a single request', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(app)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({
          displayName: 'Updated Agent',
          traits: { tone: 2, autonomy: 4, caution: 3, communication: 3, creativity: 3 },
          soulContent: '## Updated soul content',
          nopeContent: '# Updated safety rules',
        });

      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Updated Agent');
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        '## Updated soul content'
      );
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        '# Updated safety rules'
      );
    });
  });

  describe('POST /api/agents/current/migrate-persona', () => {
    it('returns 400 when path query is missing', async () => {
      const res = await request(app).post('/api/agents/current/migrate-persona');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('path query parameter required');
    });

    it('returns 404 when no manifest found', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No agent registered at this path');
    });

    it('migrates persona text to SOUL.md', async () => {
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'You are a legacy agent.',
      });
      mockReadConventionFile.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.migrated).toBe(true);
      expect(mockBuildSoulContent).toHaveBeenCalledWith(
        'rendered-traits',
        'You are a legacy agent.'
      );
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        expect.any(String)
      );
    });

    it('scaffolds NOPE.md when missing during migration', async () => {
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'You are a legacy agent.',
      });
      mockReadConventionFile.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(mockDefaultNopeTemplate).toHaveBeenCalled();
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        '# Safety Boundaries'
      );
    });

    it('is no-op when SOUL.md already exists', async () => {
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'You are a legacy agent.',
      });
      mockReadConventionFile.mockImplementation(async (_path: string, filename: string) => {
        if (filename === 'SOUL.md') return '## Existing soul';
        return null;
      });

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.migrated).toBe(false);
      expect(res.body.reason).toBe('SOUL.md already exists');
      expect(mockWriteConventionFile).not.toHaveBeenCalled();
    });

    it('is no-op when no persona field exists', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);
      mockReadConventionFile.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.migrated).toBe(false);
      expect(res.body.reason).toBe('No persona to migrate');
      expect(mockWriteConventionFile).not.toHaveBeenCalled();
    });

    it('preserves existing NOPE.md during migration', async () => {
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'Legacy persona text.',
      });
      mockReadConventionFile.mockImplementation(async (_path: string, filename: string) => {
        if (filename === 'SOUL.md') return null;
        if (filename === 'NOPE.md') return '# Existing safety rules';
        return null;
      });

      const res = await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.migrated).toBe(true);
      // Should write SOUL.md but NOT overwrite existing NOPE.md
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        expect.any(String)
      );
      expect(mockWriteConventionFile).not.toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        expect.anything()
      );
    });

    it('uses agent traits when migrating persona', async () => {
      const customTraits = { tone: 1, autonomy: 5, caution: 3, communication: 3, creativity: 3 };
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'Legacy persona.',
        traits: customTraits,
      });
      mockReadConventionFile.mockResolvedValue(null);

      await request(app)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(mockRenderTraits).toHaveBeenCalledWith({
        tone: 1,
        autonomy: 5,
        caution: 3,
        communication: 3,
        creativity: 3,
      });
    });
  });
});
