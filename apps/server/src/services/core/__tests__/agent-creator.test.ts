import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies before importing ──────────────────────────────────────

const mockWriteManifest = vi.fn();
vi.mock('@dorkos/shared/manifest', () => ({
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
}));

vi.mock('@dorkos/shared/convention-files', () => ({
  defaultSoulTemplate: vi.fn(() => '# SOUL'),
  defaultNopeTemplate: vi.fn(() => '# NOPE'),
}));

vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: vi.fn(),
}));

vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => ''),
}));

vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: vi.fn(() => '# DorkBot'),
}));

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(),
  expandTilde: vi.fn((p: string) => p.replace(/^~/, '/home/test')),
  BoundaryError: class BoundaryError extends Error {
    code = 'BOUNDARY_VIOLATION';
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({ defaultDirectory: '/home/test/.dork/agents', defaultAgent: 'dorkbot' })),
    set: vi.fn(),
  },
}));

const mockMkdir = vi.fn();
const mockStat = vi.fn();
const mockRm = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

import { createAgentWorkspace, AgentCreationError } from '../agent-creator.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
}

const mockMeshCore = { syncFromDisk: vi.fn().mockResolvedValue(true) };

describe('createAgentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directory does not exist
    mockStat.mockRejectedValue(enoent());
    mockMkdir.mockResolvedValue(undefined);
    mockWriteManifest.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(enoent());
  });

  // ── New directory (happy path) ──────────────────────────────────────────

  it('creates agent in a new directory', async () => {
    const result = await createAgentWorkspace({ name: 'my-agent' }, mockMeshCore);

    expect(result.manifest.name).toBe('my-agent');
    expect(result.path).toContain('my-agent');
    // Should create parent (recursive) + agent dir + .dork/
    expect(mockMkdir).toHaveBeenCalledTimes(3);
  });

  // ── Existing directory without .dork/ ───────────────────────────────────

  it('allows creation in an existing directory without .dork/', async () => {
    // First stat: directory exists. Second stat: .dork/ does not exist.
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(enoent())
      // Third stat: for maybeSetDefaultAgent check
      .mockRejectedValueOnce(enoent());

    const result = await createAgentWorkspace({ name: 'existing-dir' }, mockMeshCore);

    expect(result.manifest.name).toBe('existing-dir');
    // Should NOT create the agent directory itself (it already exists)
    // Should only create .dork/ inside it
    const mkdirCalls = mockMkdir.mock.calls.map((c) => c[0]);
    expect(mkdirCalls).not.toContain(expect.stringContaining('/existing-dir'));
    // .dork/ should be created
    expect(mkdirCalls).toContainEqual(expect.stringContaining('.dork'));
  });

  // ── Existing directory WITH .dork/ ──────────────────────────────────────

  it('rejects existing directory that already contains .dork/', async () => {
    // Both directory and .dork/ exist
    mockStat.mockResolvedValue({ isDirectory: () => true });

    await expect(createAgentWorkspace({ name: 'taken-agent' })).rejects.toThrow(AgentCreationError);

    try {
      await createAgentWorkspace({ name: 'taken-agent' });
    } catch (err) {
      const e = err as AgentCreationError;
      expect(e.code).toBe('COLLISION');
      expect(e.statusCode).toBe(409);
      expect(e.message).toContain('DorkOS project');
    }
  });

  // ── Template + existing directory ───────────────────────────────────────

  it('rejects template with existing directory', async () => {
    // Directory exists, no .dork/
    mockStat.mockResolvedValueOnce({ isDirectory: () => true }).mockRejectedValueOnce(enoent());

    await expect(
      createAgentWorkspace({ name: 'tpl-agent', template: 'https://github.com/example/tpl' })
    ).rejects.toThrow(AgentCreationError);

    // Reset mocks for the assertion
    mockStat.mockResolvedValueOnce({ isDirectory: () => true }).mockRejectedValueOnce(enoent());

    try {
      await createAgentWorkspace({ name: 'tpl-agent', template: 'https://github.com/example/tpl' });
    } catch (err) {
      const e = err as AgentCreationError;
      expect(e.code).toBe('COLLISION');
      expect(e.message).toContain('template');
    }
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it('rejects invalid agent name', async () => {
    await expect(createAgentWorkspace({ name: 'INVALID NAME!' })).rejects.toThrow(
      AgentCreationError
    );

    try {
      await createAgentWorkspace({ name: 'INVALID NAME!' });
    } catch (err) {
      expect((err as AgentCreationError).code).toBe('VALIDATION');
    }
  });

  it('rejects empty name', async () => {
    await expect(createAgentWorkspace({ name: '' })).rejects.toThrow(AgentCreationError);
  });

  // ── Permission errors bubble up ────────────────────────────────────────

  it('throws on permission errors when checking directory', async () => {
    mockStat.mockRejectedValue(eacces());

    await expect(createAgentWorkspace({ name: 'perm-agent' })).rejects.toThrow('EACCES');
  });

  // ── skipTemplateDownload mode ───────────────────────────────────────────

  it('skips collision check when skipTemplateDownload is true', async () => {
    // Directory exists — should not matter with skipTemplateDownload
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // for maybeSetDefaultAgent
      .mockRejectedValueOnce(enoent());

    const result = await createAgentWorkspace(
      { name: 'marketplace-agent', skipTemplateDownload: true },
      mockMeshCore
    );

    expect(result.manifest.name).toBe('marketplace-agent');
    // stat should NOT be called for collision check (only for maybeSetDefaultAgent)
  });
});
