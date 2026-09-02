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
    expect(toCodexMcpServerConfig('files', connection, new Set())).toEqual({
      config: {
        command: 'npx',
        args: ['-y', 'server-filesystem'],
        env: { API_KEY: 'x' },
      },
      env: {},
    });
  });

  it('omits empty args and env on a stdio connection', () => {
    const connection: McpAppServerConnection = {
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
    };
    const entry = toCodexMcpServerConfig('files', connection, new Set());
    expect(entry?.config).toEqual({ command: 'npx' });
    expect(entry?.config).not.toHaveProperty('args');
    expect(entry?.config).not.toHaveProperty('env');
  });

  it('names an http connection headers by env var, and never writes the value (DOR-993)', () => {
    // `config` is flattened into `--config key=value` on the `codex exec`
    // command line, so a header value written here is readable by any local
    // process with `ps`. The name goes in the config; the value goes in `env`.
    const connection: McpAppServerConnection = {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    };
    expect(toCodexMcpServerConfig('remote', connection, new Set())).toEqual({
      config: {
        url: 'https://example.com/mcp',
        env_http_headers: { Authorization: 'DORKOS_MCP_HDR_REMOTE_AUTHORIZATION' },
      },
      env: { DORKOS_MCP_HDR_REMOTE_AUTHORIZATION: 'Bearer x' },
    });
  });

  it('redirects EVERY header, not just the ones that look like credentials', () => {
    // The static-header field is exactly where people paste API keys, so there
    // is no header this path leaves on `http_headers`.
    const entry = toCodexMcpServerConfig(
      'internal',
      {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Api-Key': 'sk-live', 'X-Tenant': 'acme' },
      },
      new Set()
    );
    expect(entry?.config).not.toHaveProperty('http_headers');
    expect(entry?.env).toEqual({
      DORKOS_MCP_HDR_INTERNAL_X_API_KEY: 'sk-live',
      DORKOS_MCP_HDR_INTERNAL_X_TENANT: 'acme',
    });
  });

  it('omits empty headers on an http connection', () => {
    const entry = toCodexMcpServerConfig(
      'remote',
      { transport: 'http', url: 'https://example.com/mcp', headers: {} },
      new Set()
    );
    expect(entry).toEqual({ config: { url: 'https://example.com/mcp' }, env: {} });
    expect(entry?.config).not.toHaveProperty('env_http_headers');
    expect(entry?.config).not.toHaveProperty('http_headers');
  });

  it('returns null for an sse connection — Codex has no SSE transport', () => {
    expect(
      toCodexMcpServerConfig(
        'stream',
        { transport: 'sse', url: 'https://example.com/sse' },
        new Set()
      )
    ).toBeNull();
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

  it('collects every header value into one env map, keyed by the minted var', () => {
    const { servers, env } = toCodexMcpServers(
      {
        alpha: {
          transport: 'http',
          url: 'https://a.example.com/mcp',
          headers: { Authorization: 'Bearer a' },
        },
        beta: {
          transport: 'http',
          url: 'https://b.example.com/mcp',
          headers: { Authorization: 'Bearer b' },
        },
      },
      new Set()
    );
    expect(env).toEqual({
      DORKOS_MCP_HDR_ALPHA_AUTHORIZATION: 'Bearer a',
      DORKOS_MCP_HDR_BETA_AUTHORIZATION: 'Bearer b',
    });
    expect(JSON.stringify(servers)).not.toContain('Bearer ');
  });

  it('mints DISTINCT variables for server names that sanitise alike', () => {
    // `my-server` and `my_server` both reduce to MY_SERVER. One variable for
    // two credentials would send each server the other's token.
    const { servers, env } = toCodexMcpServers(
      {
        'my-server': {
          transport: 'http',
          url: 'https://a.example.com/mcp',
          headers: { Authorization: 'Bearer a' },
        },
        my_server: {
          transport: 'http',
          url: 'https://b.example.com/mcp',
          headers: { Authorization: 'Bearer b' },
        },
      },
      new Set()
    );
    const names = Object.values(servers).map(
      (entry) => (entry['env_http_headers'] as Record<string, string>)['Authorization']
    );
    expect(new Set(names).size).toBe(2);
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('returns empty maps for no input', () => {
    expect(toCodexMcpServers({}, new Set())).toEqual({
      servers: {},
      env: {},
      skipped: [],
      reserved: [],
    });
  });
});
