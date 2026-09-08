import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ProbeOutcome } from '../../../mesh/agent-mcp-probe.js';
import type {
  RawMcpConnectorProviderOpts,
  RawMcpPendingConnect,
  RemoteMcpConnection,
} from '../raw-mcp.js';
import { RawMcpConnectorProvider } from '../raw-mcp.js';

/** Header accepted by the listening MCP fixture. */
const AUTHORIZATION = 'Bearer configured-secret';

/** Methods the real MCP server received, proving initialize and tools/list crossed the HTTP seam. */
const receivedMethods: string[] = [];

/** A real stateless Streamable HTTP MCP server behind one listener for this test file. */
const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  if (req.get('authorization') !== AUTHORIZATION) {
    res.status(401).set('WWW-Authenticate', 'Bearer').end();
    return;
  }
  const body = req.body as { method?: string };
  if (body.method) receivedMethods.push(body.method);
  const server = new McpServer({ name: 'raw-mcp-verification-test', version: '1.0.0' });
  server.registerTool('verified-tool', { description: 'Proves tools/list completed.' }, () => ({
    content: [{ type: 'text' as const, text: 'verified' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
});
const target = swappableServer();
target.mount(app);

/** URL of the listening MCP fixture after the test helper binds it. */
function fixtureUrl(): string {
  const address = target.server.address() as AddressInfo;
  return `http://localhost:${address.port}/mcp`;
}

/** Successful probe used where a test is about the connector contract rather than MCP I/O. */
const successfulProbe = (): Promise<ProbeOutcome> => Promise.resolve({ kind: 'ok', toolCount: 1 });

const NOTION: { slug: string; displayName: string; connection: RemoteMcpConnection } = {
  slug: 'notion',
  displayName: 'Notion',
  connection: { transport: 'http', url: 'https://mcp.notion.example/mcp' },
};

/** Model the required outer durable flow port for provider-only conformance tests. */
function createProvider(opts: Omit<RawMcpConnectorProviderOpts, 'resolvePendingConnect'>) {
  const rows = new Map<string, RawMcpPendingConnect>();
  const provider: RawMcpConnectorProvider = new RawMcpConnectorProvider({
    ...opts,
    resolvePendingConnect: (current, handle) =>
      current === provider ? rows.get(handle) : undefined,
  });
  const start = provider.startConnect.bind(provider);
  provider.startConnect = async (toolkit, input) => {
    const result = await start(toolkit, input);
    rows.set(result.flowId, {
      authenticationFlowId: result.flowId,
      providerFlowId: result.flowId,
      providerInstanceId: provider.instanceId,
      executionConfigGeneration: 1,
      toolkit,
      label: input?.label ?? null,
      ownerKind: 'local_install',
      ownerId: 'fixture',
      requestHash: 'fixture-request',
      reconnectConnectionId: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    return result;
  };
  const disconnect = provider.disconnect.bind(provider);
  provider.disconnect = async (externalRef) => {
    for (const [handle, row] of rows) if (`mcp:${row.toolkit}` === externalRef) rows.delete(handle);
    await disconnect(externalRef);
  };
  return provider;
}

function makeProvider(): RawMcpConnectorProvider {
  return createProvider({ servers: [NOTION], probe: successfulProbe });
}

// The raw-MCP baseline must clear the same behavioral gate every backend does.
// Single-account (supportsMultiAccount:false), so the suite's single-account
// branch runs. The null branch is arranged via an unreachable server.
connectorConformance(makeProvider, {
  name: 'RawMcpConnectorProvider — conformance',
  toolkit: 'notion',
});

describe('RawMcpConnectorProvider — baseline semantics', () => {
  it('declares the external, single-account, brokered-execution capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'mcp',
      supportsMultiAccount: false,
      custody: 'external',
    });
  });

  it('re-verifies an already-connected toolkit without a second account', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('notion');
    await provider.pollConnect(flowId);

    const repeated = await provider.startConnect('notion');
    expect((await provider.pollConnect(repeated.flowId)).status).toBe('connected');
    const accounts = await provider.listAccounts({ toolkit: 'notion' });
    expect(accounts).toHaveLength(1);
  });

  it('does not present the MCP protocol endpoint as an OAuth consent URL', async () => {
    const provider = makeProvider();

    const start = await provider.startConnect('notion');

    expect(start).toEqual({ flowId: expect.stringMatching(/^raw-mcp:v1:[0-9a-f-]{36}$/) });
    expect((await provider.listToolkits())[0]?.authKind).toBe('none');
  });

  it('crosses a real authenticated MCP boundary before creating an active account', async () => {
    receivedMethods.length = 0;
    const connection: RemoteMcpConnection = {
      transport: 'http',
      url: fixtureUrl(),
      headers: { Authorization: AUTHORIZATION },
    };
    const provider = createProvider({
      servers: [{ slug: 'verified', displayName: 'Verified', connection }],
    });
    const { flowId } = await provider.startConnect('verified');

    const poll = await provider.pollConnect(flowId);

    expect(poll).toMatchObject({ status: 'connected', account: { status: 'active' } });
    expect(receivedMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('returns a safe unauthorized failure and creates no account when credentials are rejected', async () => {
    const provider = createProvider({
      servers: [
        {
          slug: 'rejected',
          displayName: 'Rejected',
          connection: { transport: 'http', url: fixtureUrl() },
        },
      ],
    });
    const { flowId } = await provider.startConnect('rejected');

    const first = await provider.pollConnect(flowId);
    const repeated = await provider.pollConnect(flowId);

    expect(first).toEqual({
      status: 'failed',
      error: 'The MCP server rejected the configured credentials. Check them and try again.',
    });
    expect(repeated).toEqual(first);
    await expect(provider.listAccounts()).resolves.toEqual([]);
  });

  it('distinguishes a bounded timeout without exposing the probe error', async () => {
    const provider = createProvider({
      servers: [NOTION],
      probe: () =>
        Promise.resolve({
          kind: 'failed',
          error: 'MCP server probe timed out after 10000ms: secret=do-not-return',
        }),
    });
    const { flowId } = await provider.startConnect('notion');

    const poll = await provider.pollConnect(flowId);

    expect(poll).toEqual({
      status: 'failed',
      error: 'The MCP server did not respond before the connection check timed out. Try again.',
    });
    expect(poll.error).not.toContain('do-not-return');
    await expect(provider.listAccounts()).resolves.toEqual([]);
  });

  it('maps transport failures to safe copy and shares one probe across concurrent polls', async () => {
    let resolveProbe!: (outcome: ProbeOutcome) => void;
    const probe = vi.fn(
      () =>
        new Promise<ProbeOutcome>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const provider = createProvider({ servers: [NOTION], probe });
    const { flowId } = await provider.startConnect('notion');

    const first = provider.pollConnect(flowId);
    const second = provider.pollConnect(flowId);
    resolveProbe({ kind: 'failed', error: 'fetch failed for https://user:secret@example.test' });

    await expect(first).resolves.toEqual({
      status: 'failed',
      error:
        'DorkOS could not verify the MCP server. Check its address and availability, then try again.',
    });
    await expect(second).resolves.toEqual(await first);
    expect(probe).toHaveBeenCalledOnce();
    await expect(provider.listAccounts()).resolves.toEqual([]);
  });

  it('does not let an in-flight second flow resurrect an account after disconnect', async () => {
    const pending: Array<(outcome: ProbeOutcome) => void> = [];
    const provider = createProvider({
      servers: [NOTION],
      probe: () =>
        new Promise<ProbeOutcome>((resolve) => {
          pending.push(resolve);
        }),
    });
    const firstFlow = await provider.startConnect('notion');
    const secondFlow = await provider.startConnect('notion');
    const firstPoll = provider.pollConnect(firstFlow.flowId);
    const secondPoll = provider.pollConnect(secondFlow.flowId);

    pending[0]!({ kind: 'ok', toolCount: 1 });
    const connected = await firstPoll;
    expect(connected.status).toBe('connected');
    await provider.disconnect(connected.account!.externalAccountRef);

    pending[1]!({ kind: 'ok', toolCount: 1 });
    await expect(secondPoll).resolves.toEqual({
      status: 'failed',
      error: 'This connection check is no longer active. Start again to retry.',
    });
    await expect(provider.listAccounts()).resolves.toEqual([]);
  });

  it('does not evict pending durable authority when more than100 flows start', async () => {
    const provider = makeProvider();
    const flowIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      flowIds.push((await provider.startConnect('notion')).flowId);
    }

    await expect(provider.pollConnect(flowIds[0]!)).resolves.toMatchObject({ status: 'connected' });
    const latest = await provider.pollConnect(flowIds.at(-1)!);
    await expect(provider.pollConnect(flowIds.at(-1)!)).resolves.toEqual(latest);
    expect(latest.status).toBe('connected');
  });

  it('rejects a new flow when every bounded slot is actively verifying', async () => {
    const provider = createProvider({
      servers: [NOTION],
      probe: () => new Promise<ProbeOutcome>(() => undefined),
    });
    for (let index = 0; index < 100; index += 1) {
      const flow = await provider.startConnect('notion');
      void provider.pollConnect(flow.flowId);
    }

    await expect(provider.startConnect('notion')).rejects.toThrow(
      'Too many MCP connection checks are already in progress. Try again shortly.'
    );
  });

  it('cancels a reconnect before an account row has been recreated', async () => {
    const provider = makeProvider();
    const first = await provider.startConnect('notion');
    const account = (await provider.pollConnect(first.flowId)).account!;
    await provider.disconnect(account.externalAccountRef);

    const reconnect = await provider.startConnect('notion');
    await provider.disconnect(account.externalAccountRef);

    await expect(provider.pollConnect(reconnect.flowId)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(provider.listAccounts()).resolves.toEqual([]);
  });

  it('disconnect scopes flow cleanup to the disconnected toolkit — a pending flow for another survives', async () => {
    const slack = {
      slug: 'slack',
      displayName: 'Slack',
      connection: {
        transport: 'http',
        url: 'https://mcp.slack.example/mcp',
      } as RemoteMcpConnection,
    };
    const provider = createProvider({
      servers: [NOTION, slack],
      probe: successfulProbe,
    });

    // Connect notion; start (but don't finish) a slack flow.
    const notion = await provider.startConnect('notion');
    const { account } = await provider.pollConnect(notion.flowId);
    const slackFlow = await provider.startConnect('slack');

    await provider.disconnect(account!.externalAccountRef);

    // The still-pending slack flow must resolve — it was not wiped.
    const poll = await provider.pollConnect(slackFlow.flowId);
    expect(poll.status).toBe('connected');
    expect(poll.account?.toolkit).toBe('slack');
  });
});
