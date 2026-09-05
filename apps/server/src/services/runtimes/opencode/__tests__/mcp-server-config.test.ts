import { describe, it, expect } from 'vitest';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { toOpenCodeMcpServerConfig, toOpenCodeMcpServers } from '../mcp/mcp-server-config.js';

describe('toOpenCodeMcpServerConfig', () => {
  it('maps a stdio connection to a local config with a single command array', () => {
    const conn: McpAppServerConnection = {
      transport: 'stdio',
      command: 'my-server',
      args: ['--flag', 'value'],
      env: { API_KEY: 'secret' },
    };
    expect(toOpenCodeMcpServerConfig(conn)).toEqual({
      type: 'local',
      command: ['my-server', '--flag', 'value'],
      environment: { API_KEY: 'secret' },
      enabled: true,
    });
  });

  it('omits environment when a stdio connection has none', () => {
    expect(toOpenCodeMcpServerConfig({ transport: 'stdio', command: 'srv' })).toEqual({
      type: 'local',
      command: ['srv'],
      enabled: true,
    });
  });

  it('maps an http connection to a remote config, omitting empty headers', () => {
    expect(
      toOpenCodeMcpServerConfig({ transport: 'http', url: 'https://x/mcp', headers: {} })
    ).toEqual({ type: 'remote', url: 'https://x/mcp', enabled: true });
    expect(
      toOpenCodeMcpServerConfig({
        transport: 'http',
        url: 'https://x/mcp',
        headers: { Authorization: 'Bearer t' },
      })
    ).toEqual({
      type: 'remote',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer t' },
      enabled: true,
    });
  });

  it('returns null for sse — OpenCode has no SSE transport', () => {
    expect(toOpenCodeMcpServerConfig({ transport: 'sse', url: 'https://x/sse' })).toBeNull();
  });
});

describe('toOpenCodeMcpServers', () => {
  it('converts the convertible servers and reports sse ones as skipped', () => {
    const { servers, skipped } = toOpenCodeMcpServers({
      fs: { transport: 'stdio', command: 'fs' },
      api: { transport: 'http', url: 'https://x/mcp' },
      streamy: { transport: 'sse', url: 'https://x/sse' },
    });
    expect(Object.keys(servers).sort()).toEqual(['api', 'fs']);
    expect(servers.fs).toEqual({ type: 'local', command: ['fs'], enabled: true });
    expect(servers.api).toEqual({ type: 'remote', url: 'https://x/mcp', enabled: true });
    expect(skipped).toEqual(['streamy']);
  });

  it('returns empty results for an empty input', () => {
    expect(toOpenCodeMcpServers({})).toEqual({ servers: {}, skipped: [] });
  });
});
