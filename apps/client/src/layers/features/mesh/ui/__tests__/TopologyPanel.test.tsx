/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TopologyView, TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TopologyPanel } from '../TopologyPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<TopologyAgent> = {}): TopologyAgent {
  return {
    id: 'agent-1',
    name: 'agent-one',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    healthStatus: 'stale',
    relayAdapters: [],
    relaySubject: null,
    taskCount: 0,
    lastSeenAt: null,
    lastSeenEvent: null,
    ...overrides,
  };
}

const TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES: TopologyView = {
  callerNamespace: '*',
  namespaces: [
    { namespace: 'ns-a', agentCount: 1, agents: [makeAgent({ id: 'agent-1', name: 'agent-one' })] },
    { namespace: 'ns-b', agentCount: 1, agents: [makeAgent({ id: 'agent-2', name: 'agent-two' })] },
  ],
  accessRules: [
    // A bridge-written default — must render read-only, no delete affordance.
    { sourceNamespace: 'ns-a', targetNamespace: 'ns-a', action: 'allow', origin: 'default' },
    // A user-configured explicit grant — must keep its delete affordance.
    { sourceNamespace: 'ns-a', targetNamespace: 'ns-b', action: 'allow', origin: 'explicit' },
  ],
};

function renderPanel(transportOverrides: Partial<Transport>) {
  const transport = createMockTransport(transportOverrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<TopologyPanel />, { wrapper: Wrapper });
}

describe('TopologyPanel — default vs explicit access rule affordances (DOR-336)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders no delete affordance for a bridge-written default rule', async () => {
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES),
    });

    // Wait for the access rules section to render.
    expect(await screen.findByText('Cross-Project Access Rules')).toBeInTheDocument();

    // The default rule (ns-a -> ns-a) must not have a remove button — removing
    // it wouldn't stick (re-asserted on the next agent registration) and would
    // briefly break that namespace's own agent-to-agent messaging.
    expect(
      screen.queryByRole('button', { name: 'Remove access from ns-a to ns-a' })
    ).not.toBeInTheDocument();

    // It renders as read-only instead, with a lock affordance explaining why.
    expect(screen.getByTitle('Built-in rule, always enforced — not removable')).toBeInTheDocument();
    expect(screen.getByText('built-in')).toBeInTheDocument();
  });

  it('keeps the delete affordance for a user-configured explicit rule', async () => {
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES),
    });

    expect(
      await screen.findByRole('button', { name: 'Remove access from ns-a to ns-b' })
    ).toBeInTheDocument();
  });
});
