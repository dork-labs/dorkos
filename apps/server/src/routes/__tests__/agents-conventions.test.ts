import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { MEMORY_MAX_CHARS } from '@dorkos/shared/convention-files';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
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

// Spread over the original, the way the `trait-renderer` mock below does: the
// module also carries the character budgets `UpdateAgentConventionsSchema` is
// built from, and a mock that drops them leaves the schema with no maximum.
vi.mock('@dorkos/shared/convention-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/convention-files')>()),
  buildSoulContent: (...args: unknown[]) => mockBuildSoulContent(...args),
  defaultSoulTemplate: (...args: unknown[]) => mockDefaultSoulTemplate(...args),
  defaultNopeTemplate: (...args: unknown[]) => mockDefaultNopeTemplate(...args),
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: (...args: unknown[]) => mockReadConventionFile(...args),
  writeConventionFile: (...args: unknown[]) => mockWriteConventionFile(...args),
}));

const mockRenderTraits = vi.fn();

vi.mock('@dorkos/shared/trait-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/trait-renderer')>()),
  renderTraits: (...args: unknown[]) => mockRenderTraits(...args),
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
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createAgentsRouter } from '../agents.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const app = express();
app.use(express.json());
app.use('/api/agents', createAgentsRouter());

/**
 * ONE listener for the whole file (DOR-483). Requests target `server`, never
 * `app`: handed a non-listening app supertest binds and frees an ephemeral port
 * per request, and a pooled keep-alive socket for a reclaimed port lands on the
 * wrong server. See {@link listeningServer}.
 */
const server = listeningServer(app);

const mockManifest: AgentManifest = {
  id: 'test-agent-id',
  name: 'test-agent',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
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
      const res = await request(server).post('/api/agents').send({ path: '/home/user/project' });

      expect(res.status).toBe(201);
      expect(mockDefaultSoulTemplate).toHaveBeenCalledWith('project', 'rendered-traits');
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        'default-soul-content'
      );
    });

    it('scaffolds NOPE.md with default template on agent creation', async () => {
      const res = await request(server).post('/api/agents').send({ path: '/home/user/project' });

      expect(res.status).toBe(201);
      expect(mockDefaultNopeTemplate).toHaveBeenCalled();
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        '# Safety Boundaries'
      );
    });

    it('renders traits with DEFAULT_TRAITS for scaffolding', async () => {
      await request(server).post('/api/agents').send({ path: '/home/user/project' });

      expect(mockRenderTraits).toHaveBeenCalledWith({
        verbosity: 3,
        autonomy: 3,
        chaos: 3,
        creativity: 3,
        humor: 3,
        spice: 3,
      });
    });

    it('uses provided agent name in soul template', async () => {
      await request(server)
        .post('/api/agents')
        .send({ path: '/home/user/project', name: 'My Custom Agent' });

      expect(mockDefaultSoulTemplate).toHaveBeenCalledWith('My Custom Agent', 'rendered-traits');
    });
  });

  describe('POST /api/agents (registering a directory that may already be one)', () => {
    // Red when: MEMORY.md is scaffolded unconditionally here. This route
    // registers a directory that may ALREADY have been an agent — a
    // re-register after a rename, a workspace moved and pointed at again — and
    // the memory file is the one convention file the AGENT wrote. Overwriting
    // it deletes everything the agent had learned, at a moment nobody
    // associates with data loss.
    it('never overwrites an existing MEMORY.md', async () => {
      mockReadConventionFile.mockImplementation(async (_path: string, filename: string) =>
        filename === 'MEMORY.md' ? '## Notes\n\n- years of notes\n' : null
      );

      await request(server)
        .post('/api/agents')
        .send({ path: '/home/user/project', name: 'My Agent' });

      expect(mockWriteConventionFile).not.toHaveBeenCalledWith(
        '/home/user/project',
        'MEMORY.md',
        expect.anything()
      );
    });

    it('scaffolds MEMORY.md when the directory has none', async () => {
      // The control: the guard must not turn the scaffold off entirely, or a
      // freshly registered directory never gets the file at all.
      mockReadConventionFile.mockResolvedValue(null);

      await request(server)
        .post('/api/agents')
        .send({ path: '/home/user/project', name: 'My Agent' });

      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'MEMORY.md',
        expect.stringContaining('can come up in ANY conversation')
      );
    });

    it('still rewrites SOUL.md and NOPE.md, which are scaffolds rather than notes', async () => {
      // The distinction the guard encodes, asserted rather than implied.
      mockReadConventionFile.mockResolvedValue('## existing content');

      await request(server)
        .post('/api/agents')
        .send({ path: '/home/user/project', name: 'My Agent' });

      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'SOUL.md',
        expect.anything()
      );
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'NOPE.md',
        expect.anything()
      );
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

      const res = await request(server)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.soulContent).toBe('## Identity\nI am test-agent.');
      expect(res.body.nopeContent).toBe('# Safety Boundaries\n## Never Do');
      expect(res.body.id).toBe('test-agent-id');
    });

    // Red when: the read half of `memoryContent` is dropped. This is the round
    // trip a person actually performs — save, reload, look — and the failure it
    // guards is the DOR-1253 shape: the PATCH reports success and the field
    // comes back empty on the next load.
    it('returns memoryContent alongside the other two', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);
      mockReadConventionFile.mockImplementation(async (_path: string, filename: string) => {
        if (filename === 'MEMORY.md') return '## Notes\n\n- the operator ships on Fridays\n';
        return null;
      });

      const res = await request(server)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.memoryContent).toBe('## Notes\n\n- the operator ships on Fridays\n');
    });

    it('returns null for missing convention files', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);
      mockReadConventionFile.mockResolvedValue(null);

      const res = await request(server)
        .get('/api/agents/current')
        .query({ path: '/home/user/project' });

      expect(res.status).toBe(200);
      expect(res.body.soulContent).toBeNull();
      expect(res.body.nopeContent).toBeNull();
      expect(res.body.memoryContent).toBeNull();
    });
  });

  describe('PATCH /api/agents/current (convention file writes)', () => {
    it('writes SOUL.md when soulContent is provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
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

    // Red when: the write branch is missing. Accepting the field on the wire and
    // never writing it is worse than rejecting it — the editor reports a save
    // that did not happen (DOR-1253).
    it('writes MEMORY.md when memoryContent is provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ memoryContent: '## Notes\n\n- edited by hand\n' });

      expect(res.status).toBe(200);
      expect(mockWriteConventionFile).toHaveBeenCalledWith(
        '/home/user/project',
        'MEMORY.md',
        '## Notes\n\n- edited by hand\n'
      );
    });

    it('refuses memoryContent past the cap, naming the file and the limit', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ memoryContent: 'm'.repeat(MEMORY_MAX_CHARS + 1) });

      expect(res.status).toBe(400);
      // The refusal names MEMORY.md and its own budget — not SOUL.md's, which is
      // what a `too_big` map that forgot this field would have said.
      expect(res.body.error).toContain('MEMORY.md');
      expect(res.body.error).toContain('8,000');
      expect(mockWriteConventionFile).not.toHaveBeenCalledWith(
        '/home/user/project',
        'MEMORY.md',
        expect.anything()
      );
    });

    it('accepts memoryContent exactly at the cap', async () => {
      // The control: without it, the refusal above passes for a route that
      // rejects every memoryContent.
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ memoryContent: 'm'.repeat(MEMORY_MAX_CHARS) });

      expect(res.status).toBe(200);
    });

    it('writes NOPE.md when nopeContent is provided', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
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

      const traits = { ...DEFAULT_TRAITS, verbosity: 1, autonomy: 5 };
      const res = await request(server)
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
      const res = await request(server)
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

      await request(server)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({ name: 'updated-name' });

      expect(mockWriteConventionFile).not.toHaveBeenCalled();
    });

    it('handles both manifest and convention file updates in a single request', async () => {
      mockReadManifest.mockResolvedValue(mockManifest);

      const res = await request(server)
        .patch('/api/agents/current')
        .query({ path: '/home/user/project' })
        .send({
          displayName: 'Updated Agent',
          traits: { ...DEFAULT_TRAITS, verbosity: 2, autonomy: 4 },
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
      const res = await request(server).post('/api/agents/current/migrate-persona');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('path query parameter required');
    });

    it('returns 404 when no manifest found', async () => {
      mockReadManifest.mockResolvedValue(null);

      const res = await request(server)
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

      const res = await request(server)
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

      const res = await request(server)
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

      const res = await request(server)
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

      const res = await request(server)
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

      const res = await request(server)
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
      const customTraits = {
        verbosity: 1,
        autonomy: 5,
        chaos: 3,
        creativity: 3,
        humor: 3,
        spice: 3,
      };
      mockReadManifest.mockResolvedValue({
        ...mockManifest,
        persona: 'Legacy persona.',
        traits: customTraits,
      });
      mockReadConventionFile.mockResolvedValue(null);

      await request(server)
        .post('/api/agents/current/migrate-persona')
        .query({ path: '/home/user/project' });

      expect(mockRenderTraits).toHaveBeenCalledWith({
        verbosity: 1,
        autonomy: 5,
        chaos: 3,
        creativity: 3,
        humor: 3,
        spice: 3,
      });
    });
  });
});
