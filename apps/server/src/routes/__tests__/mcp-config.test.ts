import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock boundary before importing app — pass paths through unchanged.
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

// Mock fs/promises so we can assert whether the `.mcp.json` fallback was read.
const readFileMock = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

const codexServers = [{ name: 'codex-mcp', type: 'stdio', scope: 'user' }];

// Claude has no live status here → it must fall back to `.mcp.json`.
const claudeRuntime = {
  type: 'claude-code',
  getMcpStatus: vi.fn(() => null),
};
// Codex surfaces its own configured servers via getMcpStatus.
const codexRuntime = {
  type: 'codex',
  getMcpStatus: vi.fn(() => codexServers),
};

const RUNTIMES: Record<string, typeof claudeRuntime> = {
  'claude-code': claudeRuntime,
  codex: codexRuntime,
};

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => claudeRuntime),
    has: vi.fn((type: string) => type in RUNTIMES),
    get: vi.fn((type: string) => RUNTIMES[type]),
    listRuntimes: vi.fn(() => Object.values(RUNTIMES)),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();

describe('MCP Config Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockReset();
  });

  it('GET /api/mcp-config?runtime=codex returns the codex runtime servers, not claude cache', async () => {
    const res = await request(app).get('/api/mcp-config?path=/projects/demo&runtime=codex');

    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual(codexServers);
    expect(runtimeRegistry.get).toHaveBeenCalledWith('codex');
    expect(codexRuntime.getMcpStatus).toHaveBeenCalledWith('/projects/demo');
    // The other runtime must NOT be consulted (old "first non-null" loop bug).
    expect(claudeRuntime.getMcpStatus).not.toHaveBeenCalled();
  });

  it('GET /api/mcp-config?runtime=codex never reads the Claude-format .mcp.json fallback', async () => {
    codexRuntime.getMcpStatus.mockReturnValueOnce(null);

    const res = await request(app).get('/api/mcp-config?path=/projects/demo&runtime=codex');

    expect(res.status).toBe(200);
    // Honest "no MCP servers" for a non-claude runtime with no live status.
    expect(res.body.servers).toEqual([]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('GET /api/mcp-config with no runtime falls back to .mcp.json for the default (claude) runtime', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ mcpServers: { linear: { type: 'http' }, fs: {} } })
    );

    const res = await request(app).get('/api/mcp-config?path=/projects/demo');

    expect(res.status).toBe(200);
    expect(runtimeRegistry.getDefault).toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalled();
    expect(res.body.servers).toEqual([
      { name: 'linear', type: 'http' },
      { name: 'fs', type: 'stdio' },
    ]);
  });

  it('GET /api/mcp-config?runtime=<unknown> returns 400', async () => {
    const res = await request(app).get('/api/mcp-config?path=/projects/demo&runtime=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown runtime/i);
  });
});
