import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectorRuntimePrincipalPort,
  ConnectorTurnRefusalReason,
} from '../../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../connector-tools.js';
import {
  startConnectorRuntimeMcpListener as startRawListener,
  type ConnectorRuntimeMcpListener,
  type ConnectorRuntimeMcpListenerOptions,
} from '../listener.js';

type TestListenerOptions = Omit<
  ConnectorRuntimeMcpListenerOptions,
  'agentServerFactory' | 'agentToolsEnabled'
> &
  Partial<Pick<ConnectorRuntimeMcpListenerOptions, 'agentServerFactory' | 'agentToolsEnabled'>>;

function startConnectorRuntimeMcpListener(options: TestListenerOptions) {
  return startRawListener({
    agentServerFactory: () => new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' }),
    agentToolsEnabled: () => true,
    ...options,
  });
}

const principal = {
  claims: {
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-1' },
    bindingId: 'binding-1',
    runtime: 'codex',
    canonicalSessionId: 'session-1',
    agentId: 'agent-1',
    agentPath: '/repo',
  },
} as ServerPrincipalProof;

function port(
  result:
    | { status: 'resolved'; principal: ServerPrincipalProof }
    | { status: 'refused'; reason: ConnectorTurnRefusalReason }
): ConnectorRuntimePrincipalPort {
  return {
    openTurn: vi.fn(),
    resolve: vi.fn().mockResolvedValue(result),
    revoke: vi.fn(),
  };
}

function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer turn-secret',
      [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
      [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo'),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'listener-test', version: '1.0.0' },
      },
    }),
  });
}

describe('connector runtime MCP listener', () => {
  const listeners: ConnectorRuntimeMcpListener[] = [];

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  it('binds an authenticated stateless MCP server to IPv4 loopback', async () => {
    const principals = port({ status: 'resolved', principal });
    const factory = vi.fn(
      () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' })
    );
    const listener = await startConnectorRuntimeMcpListener({ principals, serverFactory: factory });
    listeners.push(listener);

    expect(new URL(listener.url).hostname).toBe('127.0.0.1');
    const response = await request(listener.url);

    expect(response.status).toBe(200);
    expect(principals.resolve).toHaveBeenCalledWith({
      bearer: 'turn-secret',
      expectedRuntime: 'codex',
      expectedCanonicalCwd: '/repo',
    });
    expect(factory).toHaveBeenCalledWith(principal);
  });

  it('serves agent tools only from the verified turn principal', async () => {
    const agentFactory = vi.fn(
      () => new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' })
    );
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'resolved', principal }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      agentServerFactory: agentFactory,
    });
    listeners.push(listener);

    const response = await request(listener.agentUrl, {
      // Caller-controlled identity is ignored; the server factory receives the
      // principal the binding store authenticated.
      'x-dorkos-agent': 'forged-standing-token',
    });

    expect(response.status).toBe(200);
    expect(agentFactory).toHaveBeenCalledWith(principal);
  });

  it('keeps the agent route dark while runtime tools are disabled', async () => {
    const agentFactory = vi.fn(
      () => new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' })
    );
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'resolved', principal }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      agentToolsEnabled: () => false,
      agentServerFactory: agentFactory,
    });
    listeners.push(listener);

    const response = await request(listener.agentUrl);

    expect(response.status).toBe(404);
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it('rejects revoked bindings on the agent route before projection', async () => {
    const agentFactory = vi.fn(
      () => new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' })
    );
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'refused', reason: 'revoked' }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      agentServerFactory: agentFactory,
    });
    listeners.push(listener);

    const response = await request(listener.agentUrl);

    expect(response.status).toBe(401);
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it('returns the same unauthorized shape when an agent identity cannot be established', async () => {
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'resolved', principal }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      agentServerFactory: () => null,
    });
    listeners.push(listener);

    const response = await request(listener.agentUrl);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  });

  it.each<ConnectorTurnRefusalReason>([
    'invalid',
    'expired',
    'revoked',
    'wrong_runtime',
    'wrong_cwd',
    'stale_boot',
    'authority_changed',
  ])('maps %s to the same unauthorized response', async (reason) => {
    const factory = vi.fn(
      () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' })
    );
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'refused', reason }),
      serverFactory: factory,
    });
    listeners.push(listener);

    const response = await request(listener.url);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('passes the decoded canonical directory only as a resolver constraint', async () => {
    const principals = port({ status: 'resolved', principal });
    const listener = await startConnectorRuntimeMcpListener({
      principals,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    await request(listener.url, {
      [CONNECTOR_RUNTIME_KIND_HEADER]: 'opencode',
      [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo with spaces'),
    });

    expect(principals.resolve).toHaveBeenCalledWith({
      bearer: 'turn-secret',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/repo with spaces',
    });
  });

  it('rejects a browser origin from another loopback port', async () => {
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'resolved', principal }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    const response = await request(listener.url, { origin: 'http://127.0.0.1:1' });

    expect(response.status).toBe(403);
  });

  it('enforces a listener-owned rate limit independently of external MCP config', async () => {
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'refused', reason: 'invalid' }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      maxRequestsPerMinute: 1,
    });
    listeners.push(listener);

    expect((await request(listener.url)).status).toBe(401);
    const second = await request(listener.url);
    expect(second.status).toBe(429);
  });

  it('fails closed when authentication middleware did not attach a principal', async () => {
    const listener = await startConnectorRuntimeMcpListener({
      principals: port({ status: 'resolved', principal }),
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    const response = await request(listener.url, { authorization: '' });

    expect(response.status).toBe(401);
  });

  it('requires a canonical directory constraint on every runtime request', async () => {
    const principals = port({ status: 'resolved', principal });
    const listener = await startConnectorRuntimeMcpListener({
      principals,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    const response = await request(listener.url, { [CONNECTOR_RUNTIME_CWD_HEADER]: '' });

    expect(response.status).toBe(401);
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  it('keeps resolver failures inside the JSON-RPC boundary', async () => {
    const principals = port({ status: 'resolved', principal });
    vi.mocked(principals.resolve).mockRejectedValueOnce(new Error('principal store unavailable'));
    const listener = await startConnectorRuntimeMcpListener({
      principals,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    const response = await request(listener.url);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null,
    });
  });
});
