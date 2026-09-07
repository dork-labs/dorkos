import { connectorConformance } from '../connector-conformance.js';
import { FakeConnectorProvider } from '../fake-connector-provider.js';

// FakeConnectorProvider is the reference "passing" backend for the shared
// ConnectorProvider conformance suite — green here proves the suite bakes in no
// vendor assumptions, so the same assertions must pass against raw-MCP, Composio
// and Nango. Run it twice to cover both custody-flag axes.

// Multi-account (managed) — the flagship Composio shape.
connectorConformance(() => new FakeConnectorProvider({ toolkitVersion: 'trusted-version-42' }), {
  name: 'FakeConnectorProvider (multi-account, managed) — conformance',
  makeSlowExecutingProvider: () => new FakeConnectorProvider({ executeDelayMs: 100 }),
});

// Single-account (external) — the raw-MCP baseline shape.
connectorConformance(
  () => new FakeConnectorProvider({ supportsMultiAccount: false, custody: 'external' }),
  {
    name: 'FakeConnectorProvider (single-account, external) — conformance',
  }
);
