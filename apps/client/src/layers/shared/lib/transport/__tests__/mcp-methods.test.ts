// @vitest-environment jsdom
/**
 * The managed-MCP Transport methods that can only be tested at this seam: every
 * verb rides `POST /api/capabilities/:id/invoke`, and a destructive verb has to
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
  it('invokes mcp.list with the agent id and returns the list', async () => {
    stubFetch([{ name: 'fs', enabled: true }]);
    const result = await setup().listAgentMcpServers('agent-1');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/capabilities/mcp.list/invoke');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ agentId: 'agent-1' }));
    expect(result).toEqual([{ name: 'fs', enabled: true }]);
  });
});

describe('addAgentMcpServer', () => {
  const input = {
    agentId: 'agent-1',
    name: 'fs',
    connection: { transport: 'stdio' as const, command: 'npx', args: [], env: {} },
  };

  it('maps a 200 array body to an ok result', async () => {
    stubFetch([{ name: 'fs', enabled: true }], 200);
    const result = await setup().addAgentMcpServer(input);
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
    const headers = init.headers as Record<string, string>;
    expect(headers['X-DorkOS-Approval']).toBe('t-1');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sets no approval header on the first (unconfirmed) call', async () => {
    stubFetch([], 200);
    await setup().addAgentMcpServer(input);
    const [, init] = lastCall();
    // fetchJSON supplies its own default Content-Type; no approval header rides along.
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-DorkOS-Approval']).toBeUndefined();
  });
});

describe('importAgentMcpServer', () => {
  const input = { agentId: 'agent-1', name: 'filesystem' };

  it('invokes mcp.import with just the agent id and name', async () => {
    stubFetch([{ name: 'filesystem', enabled: true }], 200);
    const result = await setup().importAgentMcpServer(input);
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/capabilities/mcp.import/invoke');
    expect(init.body).toBe(JSON.stringify({ agentId: 'agent-1', name: 'filesystem' }));
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
    expect((init.headers as Record<string, string>)['X-DorkOS-Approval']).toBe('t-1');
  });
});

describe('testAgentMcpServer', () => {
  it('returns the probe result object unchanged', async () => {
    stubFetch({ ok: true, toolCount: 3 });
    const result = await setup().testAgentMcpServer('agent-1', 'fs');
    const [url] = lastCall();
    expect(url).toBe('http://localhost:4242/api/capabilities/mcp.test/invoke');
    expect(result).toEqual({ ok: true, toolCount: 3 });
  });
});
