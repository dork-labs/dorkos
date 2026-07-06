import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enumerateCodexMcpServers } from '../enumerate-mcp-servers.js';
import { resolveCodexBinaryPath } from '../check-dependencies.js';
import { runBinaryProbe } from '../../shared/run-probe.js';

vi.mock('../check-dependencies.js', () => ({
  resolveCodexBinaryPath: vi.fn(),
}));
vi.mock('../../shared/run-probe.js', () => ({
  runBinaryProbe: vi.fn(),
}));

describe('enumerateCodexMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCodexBinaryPath).mockResolvedValue('/vendor/bin/codex');
  });

  it('maps `codex mcp list --json` entries to McpServerEntry (stdio + streamable_http)', async () => {
    vi.mocked(runBinaryProbe).mockResolvedValue(
      JSON.stringify([
        { name: 'node_repl', transport: { type: 'stdio', command: '/bin/node' } },
        {
          name: 'linear',
          transport: { type: 'streamable_http', url: 'https://mcp.linear.app/sse' },
        },
      ])
    );

    const servers = await enumerateCodexMcpServers();

    expect(runBinaryProbe).toHaveBeenCalledWith(
      '/vendor/bin/codex',
      ['mcp', 'list', '--json'],
      expect.any(Number)
    );
    // scope is user-global; status is omitted (config-time connectivity is unknown).
    expect(servers).toEqual([
      { name: 'node_repl', type: 'stdio', scope: 'user' },
      { name: 'linear', type: 'http', scope: 'user' },
    ]);
    expect(servers?.every((s) => s.status === undefined)).toBe(true);
  });

  it('returns [] when no servers are configured', async () => {
    vi.mocked(runBinaryProbe).mockResolvedValue('[]');
    await expect(enumerateCodexMcpServers()).resolves.toEqual([]);
  });

  it('returns null (not []) when the binary is unresolvable', async () => {
    vi.mocked(resolveCodexBinaryPath).mockResolvedValue(null);
    await expect(enumerateCodexMcpServers()).resolves.toBeNull();
    expect(runBinaryProbe).not.toHaveBeenCalled();
  });

  it('returns null when the probe errors or times out', async () => {
    vi.mocked(runBinaryProbe).mockRejectedValue(new Error('probe timed out after 5000ms'));
    await expect(enumerateCodexMcpServers()).resolves.toBeNull();
  });

  it('returns null when the CLI output is not parseable JSON', async () => {
    vi.mocked(runBinaryProbe).mockResolvedValue('not json at all');
    await expect(enumerateCodexMcpServers()).resolves.toBeNull();
  });
});
