import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { request as httpRequest } from 'node:http';
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
import { AgentIdentitySnapshotPrincipalPort } from '../agent-identity-snapshots.js';
import { CONNECTOR_RUNTIME_REFUSAL } from '../auth.js';

type TestListenerOptions = Omit<ConnectorRuntimeMcpListenerOptions, 'agentServerFactory'> &
  Partial<Pick<ConnectorRuntimeMcpListenerOptions, 'agentServerFactory'>>;

function startConnectorRuntimeMcpListener(options: TestListenerOptions) {
  return startRawListener({
    agentServerFactory: () => new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' }),
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
    renew: vi.fn(),
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
    const factory = vi.fn(() => {
      const server = new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' });
      server.registerTool('verified', { description: 'Runtime listener proof.' }, () => ({
        content: [{ type: 'text' as const, text: 'verified' }],
      }));
      return server;
    });
    const listener = await startConnectorRuntimeMcpListener({ principals, serverFactory: factory });
    listeners.push(listener);

    expect(new URL(listener.url).hostname).toBe('127.0.0.1');
    const client = new Client({ name: 'runtime-listener-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: {
        headers: {
          authorization: 'Bearer turn-secret',
          [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
          [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo'),
        },
      },
    });
    await client.connect(transport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: 'verified' }],
    });
    await expect(client.callTool({ name: 'verified', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'verified' }],
    });
    expect(principals.resolve).toHaveBeenCalledWith({
      bearer: 'turn-secret',
      expectedRuntime: 'codex',
      expectedCanonicalCwd: '/repo',
    });
    expect(factory).toHaveBeenCalledWith(principal);
    expect(principals.renew).not.toHaveBeenCalled();
    await client.close();
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

  it('keeps the agent route available through the same successfully renewed turn binding', async () => {
    let now = new Date('2026-09-08T10:00:00.000Z');
    const renewalPermit = Object.freeze({}) as never;
    const renewedPrincipal = {
      claims: { ...principal.claims, canonicalCwd: '/repo' },
    } as ServerPrincipalProof;
    const backing: ConnectorRuntimePrincipalPort = {
      openTurn: vi.fn(async () => ({
        bindingId: 'binding-1',
        bearer: 'turn-secret',
        expiresAt: '2026-09-08T12:00:00.000Z',
        renewalPermit,
      })),
      renew: vi.fn(async () => ({
        status: 'renewed' as const,
        expiresAt: '2026-09-08T16:00:00.000Z',
      })),
      resolve: vi.fn(async () => ({
        status: 'resolved' as const,
        principal: renewedPrincipal,
      })),
      revoke: vi.fn(),
    };
    const principals = new AgentIdentitySnapshotPrincipalPort({
      principals: backing,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => now,
    });
    const opened = await principals.openTurn(
      {
        runtime: 'codex',
        canonicalSessionId: 'session-1',
        agentPath: '/repo',
        canonicalCwd: '/repo',
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    await principals.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit });
    now = new Date('2026-09-08T13:00:00.000Z');

    const listener = await startConnectorRuntimeMcpListener({
      principals,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      agentServerFactory: async (verifiedPrincipal) =>
        (await principals.identityFor(verifiedPrincipal))
          ? new McpServer({ name: 'dorkos-agent-test', version: '1.0.0' })
          : null,
    });
    listeners.push(listener);

    expect((await request(listener.agentUrl)).status).toBe(200);
    expect(backing.renew).toHaveBeenCalledWith({
      bindingId: opened.bindingId,
      permit: renewalPermit,
    });
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
      error: {
        code: -32001,
        message: 'Connections access ended. Start a new turn to continue.',
      },
      id: null,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['opencode', 'doe'] as const)(
    'passes the decoded canonical directory only as a resolver constraint for %s',
    async (runtime) => {
      const principals = port({ status: 'resolved', principal });
      const listener = await startConnectorRuntimeMcpListener({
        principals,
        serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      });
      listeners.push(listener);

      await request(listener.url, {
        [CONNECTOR_RUNTIME_KIND_HEADER]: runtime,
        [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo with spaces'),
      });

      expect(principals.resolve).toHaveBeenCalledWith({
        bearer: 'turn-secret',
        expectedRuntime: runtime,
        expectedCanonicalCwd: '/repo with spaces',
      });
    }
  );

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

  it('refuses a Claude Code claim, whose principal is only minted in process', async () => {
    const principals = port({ status: 'resolved', principal });
    const listener = await startConnectorRuntimeMcpListener({
      principals,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    for (const url of [listener.url, listener.agentUrl]) {
      const response = await request(url, { [CONNECTOR_RUNTIME_KIND_HEADER]: 'claude-code' });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual(CONNECTOR_RUNTIME_REFUSAL);
    }
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  it('accepts a Claude Code claim only when the test runtime asks for it', async () => {
    const principals = port({ status: 'resolved', principal });
    const listener = await startConnectorRuntimeMcpListener({
      principals,
      acceptInProcessRuntime: true,
      serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
    });
    listeners.push(listener);

    const response = await request(listener.url, {
      [CONNECTOR_RUNTIME_KIND_HEADER]: 'claude-code',
    });

    expect(response.status).toBe(200);
    expect(principals.resolve).toHaveBeenCalledWith({
      bearer: 'turn-secret',
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: '/repo',
    });
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

  describe('answers outside the MCP exchange itself', () => {
    const REFUSED = {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Connections access ended. Start a new turn to continue.' },
      id: null,
    };
    const PARSE_ERROR = {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    };

    async function started(maxRequestsPerMinute?: number) {
      const listener = await startConnectorRuntimeMcpListener({
        principals: port({ status: 'resolved', principal }),
        serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
        ...(maxRequestsPerMinute !== undefined && { maxRequestsPerMinute }),
      });
      listeners.push(listener);
      return listener;
    }

    /** The runtime's own headers, which every request below carries. */
    const RUNTIME_HEADERS = {
      authorization: 'Bearer turn-secret',
      [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
      [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo'),
    };

    it('refuses a bearer it cannot resolve with one JSON-RPC shape', async () => {
      const listener = await startConnectorRuntimeMcpListener({
        principals: port({ status: 'refused', reason: 'invalid' }),
        serverFactory: () => new McpServer({ name: 'dorkos-connections-test', version: '1.0.0' }),
      });
      listeners.push(listener);
      const response = await request(listener.url);
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toMatch(/^application\/json\b/);
      expect(response.headers.get('x-powered-by')).toBeNull();
      expect(await response.json()).toEqual(REFUSED);
    });

    it('counts every request against the listener’s own limit, in the standard headers', async () => {
      const listener = await started(2);
      const first = await request(listener.url);
      expect(first.headers.get('ratelimit-limit')).toBe('2');
      expect(first.headers.get('ratelimit-remaining')).toBe('1');
      await request(listener.url);
      const refused = await request(listener.url);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(await refused.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
        id: null,
      });
    });

    it('answers any method but POST with method-not-allowed, after authentication', async () => {
      const listener = await started();
      for (const url of [listener.url, listener.agentUrl]) {
        const response = await fetch(url, { method: 'GET', headers: RUNTIME_HEADERS });
        expect(response.status).toBe(405);
        expect(await response.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        });
      }
      const unauthenticated = await fetch(listener.url, { method: 'GET' });
      expect(unauthenticated.status).toBe(401);
    });

    it('answers a body it cannot parse with a JSON-RPC parse error', async () => {
      const listener = await started();
      const malformed = await fetch(listener.url, {
        method: 'POST',
        headers: { ...RUNTIME_HEADERS, 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual(PARSE_ERROR);
      const oversized = await fetch(listener.url, {
        method: 'POST',
        headers: { ...RUNTIME_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
      });
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toEqual(PARSE_ERROR);
    });

    it('answers 404 on any other path, after authentication', async () => {
      const listener = await started();
      const base = new URL(listener.url);
      for (const path of ['/', '/mcp/extra', '/other']) {
        const response = await fetch(new URL(path, base), {
          method: 'POST',
          headers: { ...RUNTIME_HEADERS, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(404);
      }
    });

    it('serves the MCP routes with a trailing slash too', async () => {
      const listener = await started();
      const response = await request(`${listener.url}/`);
      expect(response.status).toBe(200);
    });

    it('refuses a Host that does not name loopback before anything else', async () => {
      const listener = await started();
      const url = new URL(listener.url);
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              ...RUNTIME_HEADERS,
              host: 'evil.example',
              'content-type': 'application/json',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          }
        );
        req.on('error', reject);
        req.end('{}');
      });
      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Loopback origin required' },
        id: null,
      });
    });

    it('lets a browser on the listener’s own origin through, and refuses a malformed one', async () => {
      const listener = await started();
      const own = await request(listener.url, { origin: new URL(listener.url).origin });
      expect(own.status).toBe(200);
      const malformed = await request(listener.url, { origin: 'not a url' });
      expect(malformed.status).toBe(403);
    });
  });
});
