import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  expandTilde: vi.fn((p: string) => p),
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

const mockDorkbotTemplate = vi.fn(() => '# DorkBot\n\nYou are DorkBot.');

vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: (...args: unknown[]) => mockDorkbotTemplate(...args),
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

// Mock fs/promises for the creation pipeline (stat, mkdir, rm, writeFile, readFile)
const mockStat = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRm = vi.fn().mockResolvedValue(undefined);
const mockFsWriteFile = vi.fn().mockResolvedValue(undefined);
const mockFsReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    default: {
      ...actual,
      stat: (...args: unknown[]) => mockStat(...args),
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      rm: (...args: unknown[]) => mockRm(...args),
      writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
      readFile: (...args: unknown[]) => mockFsReadFile(...args),
    },
  };
});

// Mock template-downloader (dynamic import)
const mockDownloadTemplate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/core/template-downloader.js', () => ({
  downloadTemplate: (...args: unknown[]) => mockDownloadTemplate(...args),
}));

import request from 'supertest';
import express from 'express';
import { createAgentsRouter } from '../agents.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

const mockSyncFromDisk = vi.fn().mockResolvedValue(true);
const mockMeshCore = { syncFromDisk: mockSyncFromDisk };

const app = express();
app.use(express.json());
app.use('/api/agents', createAgentsRouter(mockMeshCore));

describe('POST /api/agents/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadManifest.mockResolvedValue(null);
    mockWriteManifest.mockResolvedValue(undefined);
    // Default: directory does not exist (ENOENT)
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
  });

  it('creates agent with full pipeline — 201 + manifest with correct fields', async () => {
    const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('MOCK_ULID_001');
    expect(res.body.name).toBe('my-agent');
    expect(res.body.runtime).toBe('claude-code');
    expect(res.body.registeredBy).toBe('dorkos-ui');
    expect(res.body.personaEnabled).toBe(true);
    expect(res.body.traits).toEqual({
      tone: 3,
      autonomy: 3,
      caution: 3,
      communication: 3,
      creativity: 3,
    });
    expect(res.body.conventions).toEqual({
      soul: true,
      nope: true,
      dorkosKnowledge: true,
    });
  });

  it('creates directory structure: parent (recursive) + agent dir + .dork/', async () => {
    await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    const mkdirCalls = mockMkdir.mock.calls;
    // Parent directory created recursively
    expect(mkdirCalls[0]).toEqual(['/mock/agents', { recursive: true }]);
    // Agent directory created (non-recursive)
    expect(mkdirCalls[1]).toEqual(['/mock/agents/my-agent']);
    // .dork/ subdirectory created recursively so the same code path also
    // works for the marketplace install pipeline, where the package may
    // already ship a `.dork/` directory before scaffolding runs.
    expect(mkdirCalls[2]).toEqual(['/mock/agents/my-agent/.dork', { recursive: true }]);
  });

  it('scaffolds SOUL.md and NOPE.md via writeConventionFile', async () => {
    await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(mockWriteConventionFile).toHaveBeenCalledWith(
      '/mock/agents/my-agent',
      'SOUL.md',
      expect.any(String)
    );
    expect(mockWriteConventionFile).toHaveBeenCalledWith(
      '/mock/agents/my-agent',
      'NOPE.md',
      expect.any(String)
    );
  });

  it('DorkBot creation scaffolds AGENTS.md', async () => {
    await request(app).post('/api/agents/create').send({ name: 'dorkbot' });

    expect(mockDorkbotTemplate).toHaveBeenCalled();
    expect(mockFsWriteFile).toHaveBeenCalledWith(
      '/mock/agents/dorkbot/.dork/AGENTS.md',
      '# DorkBot\n\nYou are DorkBot.',
      'utf-8'
    );
  });

  it('non-DorkBot agents do NOT get AGENTS.md', async () => {
    await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(mockDorkbotTemplate).not.toHaveBeenCalled();
    expect(mockFsWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('AGENTS.md'),
      expect.any(String),
      expect.any(String)
    );
  });

  it('returns 409 when directory already exists', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);

    const res = await request(app).post('/api/agents/create').send({ name: 'existing-agent' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Directory already exists');
  });

  it('returns 400 for invalid agent name', async () => {
    const res = await request(app).post('/api/agents/create').send({ name: 'INVALID_NAME' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 for missing name', async () => {
    const res = await request(app).post('/api/agents/create').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('rolls back on scaffold failure — directory cleaned up', async () => {
    mockWriteManifest.mockRejectedValue(new Error('disk full'));

    const res = await request(app).post('/api/agents/create').send({ name: 'fail-agent' });

    expect(res.status).toBe(500);
    expect(mockRm).toHaveBeenCalledWith('/mock/agents/fail-agent', {
      recursive: true,
      force: true,
    });
  });

  it('resolves default directory when no directory provided', async () => {
    const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(res.status).toBe(201);
    // Agent path should be default directory + name
    expect(mockMkdir.mock.calls[1][0]).toBe('/mock/agents/my-agent');
  });

  it('uses custom directory when provided', async () => {
    const res = await request(app)
      .post('/api/agents/create')
      .send({ name: 'my-agent', directory: '/custom/path/my-agent' });

    expect(res.status).toBe(201);
    expect(mockMkdir.mock.calls[1][0]).toBe('/custom/path/my-agent');
  });

  it('conventions default to all true', async () => {
    const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(res.status).toBe(201);
    expect(res.body.conventions).toEqual({
      soul: true,
      nope: true,
      dorkosKnowledge: true,
    });
  });

  it('accepts custom conventions', async () => {
    const res = await request(app)
      .post('/api/agents/create')
      .send({ name: 'my-agent', conventions: { soul: false, nope: true, dorkosKnowledge: false } });

    expect(res.status).toBe(201);
    expect(res.body.conventions).toEqual({
      soul: false,
      nope: true,
      dorkosKnowledge: false,
    });
  });

  it('accepts custom traits', async () => {
    const traits = { tone: 1, autonomy: 5, caution: 2, communication: 4, creativity: 3 };
    const res = await request(app).post('/api/agents/create').send({ name: 'my-agent', traits });

    expect(res.status).toBe(201);
    expect(res.body.traits).toEqual(traits);
  });

  it('meshCore.syncFromDisk called on success', async () => {
    await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(mockSyncFromDisk).toHaveBeenCalledWith('/mock/agents/my-agent');
  });

  it('succeeds even if meshCore.syncFromDisk fails', async () => {
    mockSyncFromDisk.mockRejectedValueOnce(new Error('sync failed'));

    const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

    expect(res.status).toBe(201);
  });

  // --- Template download integration ---

  describe('template download', () => {
    it('calls downloadTemplate when template option is provided', async () => {
      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(mockDownloadTemplate).toHaveBeenCalledWith('github:org/repo', '/mock/agents/my-agent');
    });

    it('does not call downloadTemplate when no template option', async () => {
      const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

      expect(res.status).toBe(201);
      expect(mockDownloadTemplate).not.toHaveBeenCalled();
    });

    it('rolls back directory on download failure', async () => {
      mockDownloadTemplate.mockRejectedValueOnce(new Error('clone failed'));

      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Template download failed');
      expect(res.body.error).toContain('clone failed');
      expect(mockRm).toHaveBeenCalledWith('/mock/agents/my-agent', {
        recursive: true,
        force: true,
      });
    });

    it('detects postinstall hook in package.json → _meta.hasPostInstall: true', async () => {
      mockFsReadFile.mockResolvedValueOnce(
        JSON.stringify({ scripts: { postinstall: 'node setup.js' } })
      );

      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta).toEqual({ hasPostInstall: true, templateMethod: 'git' });
    });

    it('detects setup script in package.json → _meta.hasPostInstall: true', async () => {
      mockFsReadFile.mockResolvedValueOnce(JSON.stringify({ scripts: { setup: 'bash init.sh' } }));

      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta.hasPostInstall).toBe(true);
    });

    it('detects prepare script in package.json → _meta.hasPostInstall: true', async () => {
      mockFsReadFile.mockResolvedValueOnce(
        JSON.stringify({ scripts: { prepare: 'husky install' } })
      );

      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta.hasPostInstall).toBe(true);
    });

    it('no package.json → _meta.hasPostInstall: false', async () => {
      // mockFsReadFile defaults to ENOENT rejection
      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta).toEqual({ hasPostInstall: false, templateMethod: 'git' });
    });

    it('package.json without hooks → _meta.hasPostInstall: false', async () => {
      mockFsReadFile.mockResolvedValueOnce(
        JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } })
      );

      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta).toEqual({ hasPostInstall: false, templateMethod: 'git' });
    });

    it('_meta.templateMethod reflects method used', async () => {
      const res = await request(app)
        .post('/api/agents/create')
        .send({ name: 'my-agent', template: 'github:org/repo' });

      expect(res.status).toBe(201);
      expect(res.body._meta.templateMethod).toBe('git');
    });

    it('no template option → _meta absent from response', async () => {
      const res = await request(app).post('/api/agents/create').send({ name: 'my-agent' });

      expect(res.status).toBe(201);
      expect(res.body._meta).toBeUndefined();
    });
  });

  it('validates boundary and returns 403 for out-of-bounds path', async () => {
    vi.mocked(validateBoundary).mockRejectedValueOnce(
      new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
    );

    const res = await request(app)
      .post('/api/agents/create')
      .send({ name: 'my-agent', directory: '/etc/evil' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });
});
