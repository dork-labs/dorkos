/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { toCodexMcpServerConfig, toCodexMcpServers } from '../mcp-server-config.js';
import { CODEX_UI_MCP_SERVER } from '../codex-ui-mcp-server.js';

describe('toCodexMcpServerConfig', () => {
  it('maps a stdio connection to command/args/env', () => {
    const connection: McpAppServerConnection = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-filesystem'],
      env: { API_KEY: 'x' },
    };
    expect(toCodexMcpServerConfig(connection)).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem'],
      env: { API_KEY: 'x' },
    });
  });

  it('omits empty args and env on a stdio connection', () => {
    const connection: McpAppServerConnection = {
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
    };
    const config = toCodexMcpServerConfig(connection);
    expect(config).toEqual({ command: 'npx' });
    expect(config).not.toHaveProperty('args');
    expect(config).not.toHaveProperty('env');
  });

  it('maps an http connection to url + http_headers (Codex streamable_http shape)', () => {
    const connection: McpAppServerConnection = {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    };
    expect(toCodexMcpServerConfig(connection)).toEqual({
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer x' },
    });
  });

  it('omits empty headers on an http connection', () => {
    const config = toCodexMcpServerConfig({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
    });
    expect(config).toEqual({ url: 'https://example.com/mcp' });
    expect(config).not.toHaveProperty('http_headers');
  });

  it('returns null for an sse connection — Codex has no SSE transport', () => {
    expect(toCodexMcpServerConfig({ transport: 'sse', url: 'https://example.com/sse' })).toBeNull();
  });
});

describe('toCodexMcpServers', () => {
  const stdio: McpAppServerConnection = { transport: 'stdio', command: 'npx' };
  const http: McpAppServerConnection = { transport: 'http', url: 'https://example.com/mcp' };
  const sse: McpAppServerConnection = { transport: 'sse', url: 'https://example.com/sse' };

  it('converts stdio and http servers and reports skipped sse servers', () => {
    const { servers, skipped } = toCodexMcpServers(
      { files: stdio, remote: http, stream: sse },
      new Set()
    );
    expect(servers).toEqual({
      files: { command: 'npx' },
      remote: { url: 'https://example.com/mcp' },
    });
    expect(servers).not.toHaveProperty('stream');
    expect(skipped).toEqual(['stream']);
  });

  it('drops reserved names so a managed server cannot occupy dorkos_ui', () => {
    const { servers } = toCodexMcpServers(
      { [CODEX_UI_MCP_SERVER]: stdio, files: stdio },
      new Set([CODEX_UI_MCP_SERVER])
    );
    expect(servers).not.toHaveProperty(CODEX_UI_MCP_SERVER);
    expect(servers).toHaveProperty('files');
  });

  it('REPORTS every dropped reserved name, so the caller can say so (DOR-1613)', () => {
    // The drop was silent while `dorkos_ui` was the only reserved name, which
    // nobody names a server. `dorkos` is a name a person plausibly used, and
    // watching their tools vanish with no diagnostic is the failure this closes
    // — so the names come back out, not just the survivors.
    const { servers, reserved } = toCodexMcpServers(
      { dorkos: stdio, [CODEX_UI_MCP_SERVER]: stdio, files: stdio },
      new Set([CODEX_UI_MCP_SERVER, 'dorkos'])
    );
    expect(reserved.sort()).toEqual([CODEX_UI_MCP_SERVER, 'dorkos'].sort());
    expect(servers).toEqual({ files: expect.anything() });
  });

  it('reports no collision when nothing was reserved', () => {
    // The discriminator on the case above: `reserved` has to be empty on the
    // ordinary path, or a caller that logs it would warn on every turn.
    const { reserved } = toCodexMcpServers({ files: stdio }, new Set([CODEX_UI_MCP_SERVER]));
    expect(reserved).toEqual([]);
  });

  it('returns empty maps for no input', () => {
    expect(toCodexMcpServers({}, new Set())).toEqual({ servers: {}, skipped: [], reserved: [] });
  });
});
