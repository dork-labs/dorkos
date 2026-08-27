/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TopologyView, TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { OPEN_MESH_LABEL } from '@/layers/entities/mesh';
import { TopologyPanel } from '../TopologyPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<TopologyAgent> = {}): TopologyAgent {
  return {
    workspace: { mode: 'home' },
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
    mcpServers: [],
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
  openMesh: false,
};

/** The same topology with the mesh-wide switch on. */
const TOPOLOGY_OPEN_MESH: TopologyView = {
  ...TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES,
  accessRules: [
    ...TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES.accessRules,
    // How the server reports the switch alongside the flag.
    { sourceNamespace: '*', targetNamespace: '*', action: 'allow', origin: 'explicit' },
  ],
  openMesh: true,
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

describe('TopologyPanel — the mesh-wide switch (DOR-1338)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the switch off, above the per-pair machinery', async () => {
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES),
    });

    const meshSwitch = await screen.findByRole('switch', { name: OPEN_MESH_LABEL });
    expect(meshSwitch).toBeInTheDocument();
    expect(meshSwitch).not.toBeChecked();

    // Off: the pair-grant form is live and says nothing about the switch.
    expect(screen.getByRole('button', { name: /Allow Access/ })).toBeInTheDocument();
    expect(screen.queryByText(/Already allowed by the switch above/)).not.toBeInTheDocument();
  });

  it('turns the switch on with a * -> * allow rule', async () => {
    const updateMeshAccessRule = vi.fn().mockResolvedValue({
      sourceNamespace: '*',
      targetNamespace: '*',
      action: 'allow',
      origin: 'explicit',
    });
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_WITH_DEFAULT_AND_EXPLICIT_RULES),
      updateMeshAccessRule,
    });

    await userEvent.click(await screen.findByRole('switch', { name: OPEN_MESH_LABEL }));

    expect(updateMeshAccessRule).toHaveBeenCalledWith({
      sourceNamespace: '*',
      targetNamespace: '*',
      action: 'allow',
    });
  });

  it('turns the switch off with a * -> * deny rule', async () => {
    const updateMeshAccessRule = vi.fn().mockResolvedValue({
      sourceNamespace: '*',
      targetNamespace: '*',
      action: 'deny',
      origin: 'explicit',
    });
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_OPEN_MESH),
      updateMeshAccessRule,
    });

    const meshSwitch = await screen.findByRole('switch', { name: OPEN_MESH_LABEL });
    expect(meshSwitch).toBeChecked();

    await userEvent.click(meshSwitch);

    expect(updateMeshAccessRule).toHaveBeenCalledWith({
      sourceNamespace: '*',
      targetNamespace: '*',
      action: 'deny',
    });
  });

  it('makes the pair-grant controls informational while on, keeping stored rules visible', async () => {
    renderPanel({ getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_OPEN_MESH) });

    const explanation = await screen.findByText(/Already allowed by the switch above/);
    expect(explanation).toBeInTheDocument();

    // The pickers stay in the accessibility tree — announced as unavailable and
    // pointed at the explanation, rather than removed from it. `disabled` would
    // hide the very affordance the copy is explaining.
    const source = screen.getByRole('combobox', { name: 'Source' });
    const target = screen.getByRole('combobox', { name: 'Target' });
    for (const control of [source, target, screen.getByRole('button', { name: /Allow Access/ })]) {
      expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(control).not.toBeDisabled();
      expect(control).toHaveAttribute('aria-describedby', explanation.id);
    }
    expect(explanation.id).toBeTruthy();

    // The stored pair rule is still listed and still removable — turning the
    // switch off has to put the operator back exactly where they were.
    expect(
      screen.getByRole('button', { name: 'Remove access from ns-a to ns-b' })
    ).toBeInTheDocument();
  });

  it('does not list the * -> * rule as a removable row (the switch is its control)', async () => {
    renderPanel({ getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_OPEN_MESH) });

    await screen.findByRole('switch', { name: OPEN_MESH_LABEL });
    expect(
      screen.queryByRole('button', { name: 'Remove access from * to *' })
    ).not.toBeInTheDocument();
  });

  it('adding a pair is inert while the switch is on', async () => {
    const updateMeshAccessRule = vi.fn();
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue(TOPOLOGY_OPEN_MESH),
      updateMeshAccessRule,
    });

    await screen.findByRole('switch', { name: OPEN_MESH_LABEL });
    await userEvent.click(screen.getByRole('button', { name: /Allow Access/ }));

    expect(updateMeshAccessRule).not.toHaveBeenCalled();
  });

  it('offers the switch before any namespace exists', async () => {
    renderPanel({
      getMeshTopology: vi.fn().mockResolvedValue({
        callerNamespace: '*',
        namespaces: [],
        accessRules: [],
        openMesh: false,
      } satisfies TopologyView),
    });

    // The empty state still explains itself, but the one control that matters
    // before the first agent exists is reachable rather than hidden behind it.
    expect(await screen.findByRole('switch', { name: OPEN_MESH_LABEL })).toBeInTheDocument();
    expect(
      screen.getByText('Cross-project access requires multiple namespaces')
    ).toBeInTheDocument();
  });
});
