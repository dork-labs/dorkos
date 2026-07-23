import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies before importing ──────────────────────────────────────

const mockWriteManifest = vi.fn();
vi.mock('@dorkos/shared/manifest', () => ({
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
}));

vi.mock('@dorkos/shared/convention-files', () => ({
  defaultSoulTemplate: vi.fn(() => '# SOUL'),
  defaultNopeTemplate: vi.fn(() => '# NOPE'),
  // Mirror the real signature: traits block + custom prose. Echo the prose so
  // tests can assert a seeded persona actually lands in SOUL.md.
  buildSoulContent: vi.fn((_traitBlock: string, prose: string) => `# SOUL\n${prose}`),
}));

const mockWriteConventionFile = vi.fn();
vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: (...args: unknown[]) => mockWriteConventionFile(...args),
}));

vi.mock('@dorkos/shared/trait-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/trait-renderer')>()),
  renderTraits: vi.fn(() => ''),
}));

vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: vi.fn(() => '# DorkBot'),
}));

const mockScaffoldInstructions = vi.fn(() => ({ created: [], skipped: [] }));
vi.mock('@dorkos/harness', () => ({
  scaffoldInstructions: (...args: unknown[]) => mockScaffoldInstructions(...args),
}));

const mockSeedOperatingSkills = vi.fn(() =>
  Promise.resolve({ skillsDir: '/skills', outcomes: [] })
);
vi.mock('@dorkos/operating-skills', () => ({
  seedOperatingSkills: (...args: unknown[]) => mockSeedOperatingSkills(...args),
}));

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(),
  validateBoundaryOrDorkHome: vi.fn(),
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

  // ── Cross-harness instruction scaffolding (DOR-142) ─────────────────────

  it('scaffolds cross-harness instructions for every (blank) agent', async () => {
    const result = await createAgentWorkspace({ name: 'my-agent' }, mockMeshCore);

    // Wired for all agents now, not just DorkBot — scaffolded into the workspace
    // root with a fillable default AGENTS.md body (not the DorkBot template).
    expect(mockScaffoldInstructions).toHaveBeenCalledTimes(1);
    const [rootDir, opts] = mockScaffoldInstructions.mock.calls[0] as [
      string,
      { agentsBody: string },
    ];
    expect(rootDir).toBe(result.path);
    expect(opts.agentsBody).toContain('my-agent');
    expect(opts.agentsBody).not.toBe('# DorkBot');
  });

  it('seeds the Operating DorkOS skill pack into the new workspace', async () => {
    const result = await createAgentWorkspace({ name: 'my-agent' }, mockMeshCore);

    expect(mockSeedOperatingSkills).toHaveBeenCalledTimes(1);
    expect(mockSeedOperatingSkills).toHaveBeenCalledWith(result.path);
  });

  it('uses the DorkBot template as the canonical body for DorkBot', async () => {
    await createAgentWorkspace({ name: 'dorkbot' }, mockMeshCore);

    const [, opts] = mockScaffoldInstructions.mock.calls[0] as [string, { agentsBody: string }];
    expect(opts.agentsBody).toBe('# DorkBot');
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

  // ── Seeded persona / capabilities / runtime (agent-creation redesign) ────

  it('writes a seeded persona into SOUL.md as custom prose', async () => {
    await createAgentWorkspace(
      { name: 'linear-keeper', persona: 'I keep your Linear board tidy.' },
      mockMeshCore
    );

    const soulCall = mockWriteConventionFile.mock.calls.find((c) => c[1] === 'SOUL.md');
    expect(soulCall).toBeDefined();
    expect(soulCall?.[2]).toContain('I keep your Linear board tidy.');
  });

  it('falls back to the default SOUL template when no persona is seeded', async () => {
    await createAgentWorkspace({ name: 'plain-soul' }, mockMeshCore);

    const soulCall = mockWriteConventionFile.mock.calls.find((c) => c[1] === 'SOUL.md');
    // The default-template mock returns a bare '# SOUL' (no echoed prose).
    expect(soulCall?.[2]).toBe('# SOUL');
  });

  it('passes seeded capabilities through to the manifest', async () => {
    const result = await createAgentWorkspace(
      { name: 'cap-agent', capabilities: ['linear', 'triage'] },
      mockMeshCore
    );

    expect(result.manifest.capabilities).toEqual(['linear', 'triage']);
  });

  it('defaults capabilities to an empty list when unset', async () => {
    const result = await createAgentWorkspace({ name: 'plain-agent' }, mockMeshCore);

    expect(result.manifest.capabilities).toEqual([]);
  });

  it('respects a seeded runtime on the manifest', async () => {
    const result = await createAgentWorkspace(
      { name: 'codex-agent', runtime: 'codex' },
      mockMeshCore
    );

    expect(result.manifest.runtime).toBe('codex');
  });

  it('persists a chosen emoji face on the manifest', async () => {
    const result = await createAgentWorkspace({ name: 'faced-agent', icon: '🦊' }, mockMeshCore);

    expect(result.manifest.icon).toBe('🦊');
  });

  it('omits the icon when no face is chosen', async () => {
    const result = await createAgentWorkspace({ name: 'faceless-agent' }, mockMeshCore);

    expect(result.manifest.icon).toBeUndefined();
  });

  it('rejects a persona over the 4000-char bound', async () => {
    await expect(
      createAgentWorkspace({ name: 'too-much', persona: 'x'.repeat(4001) })
    ).rejects.toThrow(AgentCreationError);

    try {
      await createAgentWorkspace({ name: 'too-much', persona: 'x'.repeat(4001) });
    } catch (err) {
      expect((err as AgentCreationError).code).toBe('VALIDATION');
    }
  });
});
