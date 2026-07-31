/**
 * The default runtime is not assumed to be Claude (DOR-768, spec
 * `execution-defaults` §7).
 *
 * Four read surfaces fall back to `runtimeRegistry.getDefault()` when the caller
 * has no session context — models, commands, subagents, and MCP config. Their
 * per-route tests all pin `claude-code` as the default, so between them they
 * prove the fallback works and prove nothing about what it returns when
 * `runtimes.default` is `opencode`. This file is that missing half: one server
 * whose default is a non-Claude runtime, exercising all four fallbacks together.
 *
 * Each assertion is written so a Claude-shaped assumption fails it: the models,
 * commands, and subagents must be OpenCode's own (not Anthropic's), and MCP
 * config must report no servers rather than reading the `.mcp.json` file that
 * only Claude Code writes.
 */
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

// Mocked so the test can assert whether the Claude-only `.mcp.json` fallback
// was reached. It has real content: a route that reads it would pass a weaker
// assertion that only checked for an empty response.
const readFileMock = vi.fn(async (..._args: unknown[]) =>
  JSON.stringify({ mcpServers: { linear: { type: 'http' } } })
);
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

const openCodeModels = [
  {
    value: 'anthropic/claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    description: 'via OpenCode',
  },
  { value: 'openai/gpt-5.5', displayName: 'GPT-5.5', description: 'via OpenCode' },
];
const openCodeCommands = { commands: [{ name: 'oc-init', description: 'OpenCode command' }] };
const openCodeSubagents = [{ name: 'oc-reviewer', description: 'OpenCode subagent' }];

/**
 * An OpenCode-shaped runtime: it answers the four interface methods and has no
 * Claude-specific surface at all. `getMcpStatus` returns null — the case that
 * used to fall through to `.mcp.json`.
 */
const openCodeRuntime = {
  type: 'opencode',
  getSupportedModels: vi.fn(async () => openCodeModels),
  getCommands: vi.fn(async () => openCodeCommands),
  getSupportedSubagents: vi.fn(async () => openCodeSubagents),
  getMcpStatus: vi.fn(() => null),
};

const RUNTIMES: Record<string, typeof openCodeRuntime> = { opencode: openCodeRuntime };

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    // `runtimes.default: opencode` — the acceptance configuration for DOR-768.
    getDefault: vi.fn(() => openCodeRuntime),
    getDefaultType: vi.fn(() => 'opencode'),
    getAllCapabilities: vi.fn(() => ({})),
    has: vi.fn((type: string) => type in RUNTIMES),
    get: vi.fn((type: string) => RUNTIMES[type]),
    listRuntimes: vi.fn(() => Object.values(RUNTIMES)),
    resolveForSession: vi.fn(async () => openCodeRuntime),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';

const app = createApp();

describe('cold-discovery routes with a non-Claude default runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/models returns the default runtime own catalog', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(openCodeModels);
  });

  it('GET /api/commands returns the default runtime own commands', async () => {
    const res = await request(app).get('/api/commands');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(openCodeCommands);
  });

  it('GET /api/subagents returns the default runtime own subagents', async () => {
    const res = await request(app).get('/api/subagents');
    expect(res.status).toBe(200);
    expect(res.body.subagents).toEqual(openCodeSubagents);
  });

  it('GET /api/mcp-config reports no servers instead of reading Claude .mcp.json', async () => {
    const res = await request(app).get('/api/mcp-config?path=/projects/demo');
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([]);
    // The load-bearing half: `.mcp.json` is a Claude Code artifact. Reading it
    // for an OpenCode default would attribute Claude's MCP servers to OpenCode.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('GET /api/capabilities reports the non-Claude default', async () => {
    const res = await request(app).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.defaultRuntime).toBe('opencode');
  });
});
