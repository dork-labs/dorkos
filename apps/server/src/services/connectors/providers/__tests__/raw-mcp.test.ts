import { describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type { RemoteMcpConnection } from '../raw-mcp.js';
import { RawMcpConnectorProvider } from '../raw-mcp.js';

const NOTION: { slug: string; displayName: string; connection: RemoteMcpConnection } = {
  slug: 'notion',
  displayName: 'Notion',
  connection: { transport: 'http', url: 'https://mcp.notion.example/mcp' },
};

function makeProvider(): RawMcpConnectorProvider {
  return new RawMcpConnectorProvider({ servers: [NOTION] });
}

// The raw-MCP baseline must clear the same behavioral gate every backend does.
// Single-account (supportsMultiAccount:false), so the suite's single-account
// branch runs. The null branch is arranged via an unreachable server.
connectorConformance(makeProvider, {
  name: 'RawMcpConnectorProvider — conformance',
  toolkit: 'notion',
  makeUnexposableAccount: async () => {
    const provider = new RawMcpConnectorProvider({
      servers: [NOTION],
      isReachable: () => false,
    });
    const { flowId } = await provider.startConnect('notion');
    const { account } = await provider.pollConnect(flowId);
    return { provider, accountId: account!.id };
  },
});

describe('RawMcpConnectorProvider — baseline semantics', () => {
  it('declares the external, single-account, MCP-exposing capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'mcp',
      supportsMultiAccount: false,
      custody: 'external',
      exposesOverMcp: true,
    });
  });

  it('rejects a second connect of an already-connected toolkit — never a second account', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('notion');
    await provider.pollConnect(flowId);

    await expect(provider.startConnect('notion')).rejects.toThrow(/already connected/);
    const accounts = await provider.listAccounts({ toolkit: 'notion' });
    expect(accounts).toHaveLength(1);
  });

  it('exposes the configured http connection for a reachable, active account', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('notion');
    const { account } = await provider.pollConnect(flowId);

    const connection = await provider.toolServerForAccount(account!.id);
    expect(connection).toEqual(NOTION.connection);
  });

  it('returns null when the remote server is unreachable', async () => {
    const provider = new RawMcpConnectorProvider({ servers: [NOTION], isReachable: () => false });
    const { flowId } = await provider.startConnect('notion');
    const { account } = await provider.pollConnect(flowId);

    await expect(provider.toolServerForAccount(account!.id)).resolves.toBeNull();
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
    const provider = new RawMcpConnectorProvider({ servers: [NOTION, slack] });

    // Connect notion; start (but don't finish) a slack flow.
    const notion = await provider.startConnect('notion');
    const { account } = await provider.pollConnect(notion.flowId);
    const slackFlow = await provider.startConnect('slack');

    await provider.disconnect(account!.id);

    // The still-pending slack flow must resolve — it was not wiped.
    const poll = await provider.pollConnect(slackFlow.flowId);
    expect(poll.status).toBe('connected');
    expect(poll.account?.toolkit).toBe('slack');
  });

  it('returns null for an unknown account id rather than throwing', async () => {
    const provider = makeProvider();
    await expect(
      provider.toolServerForAccount('mcp:nope' as ConnectedAccountId)
    ).resolves.toBeNull();
  });
});
