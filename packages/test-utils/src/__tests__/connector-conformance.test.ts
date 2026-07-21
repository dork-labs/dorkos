import { describe, expect, it } from 'vitest';
import { connectorConformance } from '../connector-conformance.js';
import { FakeConnectorProvider } from '../fake-connector-provider.js';

// FakeConnectorProvider is the reference "passing" backend for the shared
// ConnectorProvider conformance suite — green here proves the suite bakes in no
// vendor assumptions, so the same assertions must pass against raw-MCP, Composio
// and Nango. Run it twice to cover both custody-flag axes.

// Multi-account (managed) — the flagship Composio shape.
connectorConformance(() => new FakeConnectorProvider(), {
  name: 'FakeConnectorProvider (multi-account, managed) — conformance',
  makeUnexposableAccount: async () => {
    const provider = new FakeConnectorProvider();
    const { flowId } = await provider.startConnect('gmail');
    const { account } = await provider.pollConnect(flowId);
    provider.setStatus(account!.id, 'expired');
    return { provider, accountId: account!.id };
  },
});

// Single-account (external) — the raw-MCP baseline shape.
connectorConformance(
  () => new FakeConnectorProvider({ supportsMultiAccount: false, custody: 'external' }),
  {
    name: 'FakeConnectorProvider (single-account, external) — conformance',
    makeUnexposableAccount: async () => {
      const provider = new FakeConnectorProvider({
        supportsMultiAccount: false,
        custody: 'external',
      });
      const { flowId } = await provider.startConnect('gmail');
      const { account } = await provider.pollConnect(flowId);
      provider.setStatus(account!.id, 'revoked');
      return { provider, accountId: account!.id };
    },
  }
);

// No MCP exposure (exposesOverMcp:false) — a backend that connects accounts but
// cannot surface them as tool servers. The suite's exposure test asserts a
// healthy account resolves null here.
connectorConformance(() => new FakeConnectorProvider({ exposesOverMcp: false }), {
  name: 'FakeConnectorProvider (no MCP exposure) — conformance',
  makeUnexposableAccount: async () => {
    const provider = new FakeConnectorProvider({ exposesOverMcp: false });
    const { flowId } = await provider.startConnect('gmail');
    const { account } = await provider.pollConnect(flowId);
    // A healthy, active account is already unexposable when exposesOverMcp:false.
    return { provider, accountId: account!.id };
  },
});

// Guard: the null-branch assertion the suite runs would FAIL for a provider
// that throws instead of returning null. An active account exposes a server; an
// expired one resolves null — never a throw.
describe('connectorConformance null-branch contract', () => {
  it('active exposes a tool server; expired resolves null (the branch a throwing provider fails)', async () => {
    const provider = new FakeConnectorProvider();
    const { flowId } = await provider.startConnect('gmail');
    const { account } = await provider.pollConnect(flowId);

    await expect(provider.toolServerForAccount(account!.id)).resolves.not.toBeNull();

    provider.setStatus(account!.id, 'expired');
    await expect(provider.toolServerForAccount(account!.id)).resolves.toBeNull();
  });
});
