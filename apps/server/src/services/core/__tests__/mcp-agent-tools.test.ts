import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/index.js';

// ── Mock all dependencies before importing the handler ────────────────────────

const mockWriteManifest = vi.fn();
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
}));

vi.mock('@dorkos/shared/convention-files', () => ({
  defaultSoulTemplate: vi.fn(() => '# SOUL'),
  defaultNopeTemplate: vi.fn(() => '# NOPE'),
  buildSoulContent: vi.fn(() => '# SOUL'),
}));

vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: vi.fn(),
  readConventionFile: vi.fn(),
}));

vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => ''),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
}));

vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: vi.fn(() => '# DorkBot'),
}));

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(),
  expandTilde: vi.fn((p: string) => p),
  BoundaryError: class BoundaryError extends Error {
    code = 'BOUNDARY_VIOLATION';
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({ defaultDirectory: '/tmp/agents', defaultAgent: 'dorkbot' })),
    set: vi.fn(),
  },
}));

const mockMkdir = vi.fn();
const mockStat = vi.fn();
const mockRm = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

import { createCreateAgentHandler } from '../../runtimes/claude-code/mcp-tools/agent-tools.js';

function createMockDeps(): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    meshCore: {
      syncFromDisk: vi.fn().mockResolvedValue(true),
    } as unknown as McpToolDeps['meshCore'],
  };
}

describe('create_agent MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directory does not exist (ENOENT)
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteManifest.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('creates agent and returns manifest JSON on valid name', async () => {
    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    const result = await handler({ name: 'my-agent' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('my-agent');
    expect(parsed.id).toBeDefined();
    expect(parsed.runtime).toBe('claude-code');
    expect(parsed.registeredAt).toBeDefined();
  });

  it('returns isError true for invalid name (not kebab-case)', async () => {
    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    const result = await handler({ name: 'My Agent!' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe('VALIDATION');
  });

  it('returns isError true when name is empty string', async () => {
    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    // Empty string fails the kebab-case regex
    const result = await handler({ name: '' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it('passes optional description and runtime through to manifest', async () => {
    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    const result = await handler({
      name: 'test-bot',
      description: 'A test bot',
      runtime: 'cursor',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.description).toBe('A test bot');
    expect(parsed.runtime).toBe('cursor');
  });

  it('returns isError true when directory already contains a DorkOS project', async () => {
    // Both directory and .dork/ exist — existing project
    mockStat.mockResolvedValue({ isDirectory: () => true });

    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    const result = await handler({ name: 'existing-agent' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('DorkOS project');
    expect(parsed.code).toBe('COLLISION');
  });

  it('allows creation in an existing directory without .dork/', async () => {
    // Directory exists but .dork/ does not
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // resolvedPath exists
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); // .dork/ missing

    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    const result = await handler({ name: 'existing-dir-agent' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('existing-dir-agent');
    // Should NOT call mkdir for the agent directory (it already exists)
    expect(mockMkdir).not.toHaveBeenCalledWith('/tmp/agents/existing-dir-agent');
  });

  it('syncs to mesh after successful creation', async () => {
    const deps = createMockDeps();
    const handler = createCreateAgentHandler(deps);

    await handler({ name: 'sync-agent' });

    expect(deps.meshCore!.syncFromDisk).toHaveBeenCalled();
  });
});
