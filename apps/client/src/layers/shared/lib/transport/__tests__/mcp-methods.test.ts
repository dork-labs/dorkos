/**
 * The managed-MCP Transport methods that can only be tested at this seam. Each
 * request is pinned in `generated-client-requests.test.ts`; what stays here is
 * what the methods do with the answer: a paged list read whole in server order,
 * and a destructive verb telling a `200` (the updated list) apart from a `202`
 * (an approval envelope) by the body's shape, since both are OK.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createMcpMethods } from '../mcp-methods';

const methods = createMcpMethods('/api');

/** Answer each request with the next body, at `status`, and record what was sent. */
function answers(bodies: unknown[], status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(bodies.shift()), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('listAgentMcpServers', () => {
  it('reads every page of the agent’s list, in order (DOR-4982)', async () => {
    const fetchMock = answers([
      { servers: [{ name: 'zz', enabled: true }], nextCursor: 'c1' },
      { servers: [{ name: 'fs', enabled: true }], nextCursor: null },
    ]);
    const result = await methods.listAgentMcpServers('agent 1');
    expect(fetchMock.mock.calls[1]![0]).toBe(
      '/api/agents/agent%201/mcp-servers?cursor=c1&limit=200'
    );
    expect(result.map((server) => server.name)).toEqual(['zz', 'fs']);
  });
});

describe('a destructive verb', () => {
  const input = {
    agentId: 'agent-1',
    name: 'fs',
    connection: { transport: 'stdio' as const, command: 'npx', args: [], env: {} },
  };

  it('maps a 200 to ok with the updated list', async () => {
    answers([[{ name: 'fs', enabled: true }]]);
    await expect(methods.addAgentMcpServer(input)).resolves.toEqual({
      status: 'ok',
      servers: [{ name: 'fs', enabled: true }],
    });
  });

  it('maps a 202 approval envelope to approval_required, added or imported', async () => {
    const approval = { status: 'approval_required', approvalId: 'a-1', approvalToken: 't-1' };
    answers([approval, approval], 202);
    await expect(methods.addAgentMcpServer(input)).resolves.toEqual({
      status: 'approval_required',
      approval,
    });
    await expect(methods.importAgentMcpServer(input)).resolves.toEqual({
      status: 'approval_required',
      approval,
    });
  });
});

describe('the sign-in verbs', () => {
  it('invoke their capability with only its own input', async () => {
    const fetchMock = answers([{ flowId: 'flow-1' }, { status: 'connected' }]);
    await methods.startMcpSignin('agent-1', 'granola');
    await expect(methods.pollMcpSignin('flow-1')).resolves.toEqual({ status: 'connected' });
    const sent = fetchMock.mock.calls.map(([url, init]) => `${url} ${String(init?.body)}`);
    expect(sent).toEqual([
      '/api/capabilities/mcp.signin/invoke {"agentId":"agent-1","name":"granola"}',
      '/api/capabilities/mcp.poll_signin/invoke {"flowId":"flow-1"}',
    ]);
  });
});
