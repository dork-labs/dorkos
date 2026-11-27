// @vitest-environment jsdom
/**
 * The managed-MCP Transport methods that can only be tested at this seam: each
 * verb rides its capability's REST path (`/api/agents/:agentId/mcp-servers…`,
 * or the invoke endpoint for the three with none), and a destructive verb has to
 * tell a `200` (the updated list) apart from a `202` (an approval envelope) —
 * both of which `fetchJSON` treats as OK. The discrimination is by body shape,
 * so it is invisible above this seam where the mock Transport lives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMcpMethods } from '../mcp-methods';

function setup() {
  return createMcpMethods('http://localhost:4242/api');
}

/** The URL and `RequestInit` the last `fetch` call was made with. */
function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

/** Stub `fetch` with a single OK JSON body at the given status. */
function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status, json: () => Promise.resolve(body) })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listAgentMcpServers', () => {
  it('reads every page of the agent’s list from its REST path, in order (DOR-4982)', async () => {
    const pages = [
      { servers: [{ name: 'zz', enabled: true }], nextCursor: 'c1' },
      { servers: [{ name: 'fs', enabled: true }], nextCursor: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: () => Promise.resolve(pages.shift()) }))
    );
    const result = await setup().listAgentMcpServers('agent 1');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent%201/mcp-servers?cursor=c1&limit=200');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(result.map((server) => server.name)).toEqual(['zz', 'fs']);
  });
});

describe('addAgentMcpServer', () => {
  const input = {
    agentId: 'agent-1',
    name: 'fs',
    connection: { transport: 'stdio' as const, command: 'npx', args: [], env: {} },
  };

  it('posts the server, without the agent id the path carries, and maps a 200 to ok', async () => {
    stubFetch([{ name: 'fs', enabled: true }], 200);
    const result = await setup().addAgentMcpServer(input);
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent-1/mcp-servers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'fs', connection: input.connection });
    expect(result).toEqual({ status: 'ok', servers: [{ name: 'fs', enabled: true }] });
  });

  it('maps a 202 approval envelope to an approval_required result', async () => {
    const approval = { status: 'approval_required', approvalId: 'a-1', approvalToken: 't-1' };
    stubFetch(approval, 202);
    const result = await setup().addAgentMcpServer(input);
    expect(result).toEqual({ status: 'approval_required', approval });
  });

  it('sends the approval token and keeps Content-Type on the retry', async () => {
    stubFetch([{ name: 'fs', enabled: true }], 200);
    await setup().addAgentMcpServer(input, { approvalToken: 't-1' });
    const [, init] = lastCall();
    const headers = new Headers(init.headers);
    expect(headers.get('X-DorkOS-Approval')).toBe('t-1');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('sets no approval header on the first (unconfirmed) call', async () => {
    stubFetch([], 200);
    await setup().addAgentMcpServer(input);
    const [, init] = lastCall();
    // fetchJSON supplies its own default Content-Type; no approval header rides along.
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('X-DorkOS-Approval')).toBe(false);
  });
});

describe('importAgentMcpServer', () => {
  const input = { agentId: 'agent-1', name: 'filesystem' };

  it('posts to the discovered server’s import path with an empty body', async () => {
    stubFetch([{ name: 'filesystem', enabled: true }], 200);
    const result = await setup().importAgentMcpServer(input);
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent-1/mcp-servers/filesystem/import');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({}));
    expect(result).toEqual({ status: 'ok', servers: [{ name: 'filesystem', enabled: true }] });
  });

  it('maps a 202 approval envelope to an approval_required result', async () => {
    const approval = { status: 'approval_required', approvalId: 'a-1', approvalToken: 't-1' };
    stubFetch(approval, 202);
    const result = await setup().importAgentMcpServer(input);
    expect(result).toEqual({ status: 'approval_required', approval });
  });

  it('carries the approval token on the confirming retry', async () => {
    stubFetch([{ name: 'filesystem', enabled: true }], 200);
    await setup().importAgentMcpServer(input, { approvalToken: 't-1' });
    const [, init] = lastCall();
    expect(new Headers(init.headers).get('X-DorkOS-Approval')).toBe('t-1');
  });
});

describe('updateAgentMcpServer', () => {
  it('patches the server’s path with only the changed fields', async () => {
    stubFetch([{ name: 'fs', enabled: false }], 200);
    const result = await setup().updateAgentMcpServer({
      agentId: 'agent-1',
      name: 'fs',
      enabled: false,
    });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent-1/mcp-servers/fs');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    expect(result).toEqual({ status: 'ok', servers: [{ name: 'fs', enabled: false }] });
  });
});

describe('the reversible verbs', () => {
  it.each([
    ['removeAgentMcpServer', 'DELETE', ''],
    ['enableAgentMcpServer', 'POST', '/enable'],
    ['disableAgentMcpServer', 'POST', '/disable'],
  ] as const)('%s calls %s on the server’s path', async (method, verb, suffix) => {
    stubFetch([], 200);
    await setup()[method]('agent-1', 'my server');
    const [url, init] = lastCall();
    expect(url).toBe(`http://localhost:4242/api/agents/agent-1/mcp-servers/my%20server${suffix}`);
    expect(init.method).toBe(verb);
  });
});

describe('testAgentMcpServer', () => {
  it('returns the probe result object unchanged', async () => {
    stubFetch({ ok: true, toolCount: 3 });
    const result = await setup().testAgentMcpServer('agent-1', 'fs');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent-1/mcp-servers/fs/test');
    expect(init.method).toBe('POST');
    expect(result).toEqual({ ok: true, toolCount: 3 });
  });
});

describe('setMcpClientCredentials', () => {
  it('puts the client id on the server’s client path, leaving out an empty secret', async () => {
    stubFetch({ ok: true });
    await setup().setMcpClientCredentials('agent-1', 'granola', { clientId: 'c-1' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/agents/agent-1/mcp-servers/granola/client');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ clientId: 'c-1' });
  });
});

describe('startMcpSignin', () => {
  it('invokes mcp.signin with the agent id and name and returns the sign-in result', async () => {
    const signin = {
      flowId: 'flow-1',
      authorizeUrl: 'https://auth.example/authorize',
      alreadyConnected: false,
      disclosure: 'DorkOS keeps the token on this computer.',
      message: 'link',
    };
    stubFetch(signin);
    const result = await setup().startMcpSignin('agent-1', 'granola');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/capabilities/mcp.signin/invoke');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ agentId: 'agent-1', name: 'granola' }));
    expect(result).toEqual(signin);
  });
});

describe('pollMcpSignin', () => {
  it('invokes mcp.poll_signin with just the flow id and returns the status', async () => {
    stubFetch({ status: 'connected' });
    const result = await setup().pollMcpSignin('flow-1');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/capabilities/mcp.poll_signin/invoke');
    expect(init.body).toBe(JSON.stringify({ flowId: 'flow-1' }));
    expect(result).toEqual({ status: 'connected' });
  });
});
