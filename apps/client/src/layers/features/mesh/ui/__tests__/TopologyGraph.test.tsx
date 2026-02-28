/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — replace the full canvas with simple HTML stubs so we
// can test TopologyGraph data plumbing without a real ReactFlow renderer.
// ---------------------------------------------------------------------------
let capturedReactFlowProps: Record<string, unknown> = {};

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    capturedReactFlowProps = props;
    const nodes = props.nodes as Array<{ id: string; type: string; data: Record<string, unknown> }>;
    const edges = props.edges as Array<{ id: string; type: string; source: string; target: string }>;
    return (
      <div data-testid="react-flow">
        {nodes?.map((n) => (
          <div key={n.id} data-testid={`node-${n.id}`} data-type={n.type}>
            {String((n.data as Record<string, unknown>).label ?? (n.data as Record<string, unknown>).adapterName ?? n.id)}
          </div>
        ))}
        {edges?.map((e) => (
          <div key={e.id} data-testid={`edge-${e.id}`} data-type={e.type} data-source={e.source} data-target={e.target} />
        ))}
      </div>
    );
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ setCenter: vi.fn(), getZoom: () => 1.0 }),
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  MiniMap: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

// Mock ELK layout — returns nodes with position set to { x: 0, y: 0 }
vi.mock('elkjs/lib/elk.bundled.js', () => {
  return {
    default: class MockELK {
      async layout(graph: { children?: Array<{ id: string; children?: Array<{ id: string }> }> }) {
        return {
          ...graph,
          children: graph.children?.map((child) => ({
            ...child,
            x: 0,
            y: 0,
            width: 240,
            height: 150,
            children: child.children?.map((c) => ({ ...c, x: 0, y: 0 })),
          })),
        };
      }
    },
  };
});

// Mock TopologyLegend
vi.mock('../TopologyLegend', () => ({
  TopologyLegend: () => null,
}));

// Mock NamespaceGroupNode, CrossNamespaceEdge, DenyEdge
vi.mock('../NamespaceGroupNode', () => ({
  NamespaceGroupNode: () => <div data-testid="namespace-group" />,
}));
vi.mock('../CrossNamespaceEdge', () => ({
  CrossNamespaceEdge: () => null,
}));
vi.mock('../DenyEdge', () => ({
  DenyEdge: () => null,
}));

// Mock AgentNode, AdapterNode, BindingEdge, BindingDialog
vi.mock('../AgentNode', () => ({
  AgentNode: () => <div data-testid="agent-node" />,
}));
vi.mock('../AdapterNode', () => ({
  AdapterNode: () => <div data-testid="adapter-node" />,
  ADAPTER_NODE_WIDTH: 200,
  ADAPTER_NODE_HEIGHT: 100,
}));
vi.mock('../BindingEdge', () => ({
  BindingEdge: () => <div data-testid="binding-edge" />,
}));
vi.mock('../BindingDialog', () => ({
  BindingDialog: (props: { open: boolean; adapterName: string; agentName: string }) => (
    props.open ? (
      <div data-testid="binding-dialog">
        <span data-testid="dialog-adapter">{props.adapterName}</span>
        <span data-testid="dialog-agent">{props.agentName}</span>
      </div>
    ) : null
  ),
}));

// Mock namespace-colors
vi.mock('../../lib/namespace-colors', () => ({
  getNamespaceColor: (idx: number) => `color-${idx}`,
}));

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------
const mockTopologyData = {
  namespaces: [
    {
      namespace: 'default',
      agentCount: 2,
      agents: [
        {
          id: 'agent-1',
          name: 'Builder',
          runtime: 'claude-code',
          capabilities: ['code'],
          healthStatus: 'active',
          dir: '/projects/builder',
        },
        {
          id: 'agent-2',
          name: 'Writer',
          runtime: 'claude-code',
          capabilities: ['docs'],
          healthStatus: 'stale',
          dir: '/projects/writer',
        },
      ],
    },
  ],
  accessRules: [],
};

const mockAdapters = [
  {
    config: { id: 'tg-1', type: 'telegram', enabled: true, config: {} },
    status: { id: 'tg-1', type: 'telegram', displayName: 'Telegram Bot', state: 'connected', messageCount: { inbound: 0, outbound: 0 } },
  },
  {
    config: { id: 'wh-1', type: 'webhook', enabled: true, config: {} },
    status: { id: 'wh-1', type: 'webhook', displayName: 'Webhook Inbound', state: 'disconnected', messageCount: { inbound: 0, outbound: 0 } },
  },
];

const mockBindings = [
  {
    id: 'bind-1',
    adapterId: 'tg-1',
    agentId: 'agent-1',
    agentDir: '/projects/builder',
    sessionStrategy: 'per-chat' as const,
    label: 'Support',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const mockUseTopology = vi.fn();
const mockUseRelayEnabled = vi.fn();
const mockUseRelayAdapters = vi.fn();
const mockUseBindings = vi.fn();
const mockCreateBindingMutate = vi.fn();
const mockDeleteBindingMutate = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useTopology: () => mockUseTopology(),
}));

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => mockUseRelayEnabled(),
  useRelayAdapters: (enabled: boolean) => mockUseRelayAdapters(enabled),
}));

vi.mock('@/layers/entities/binding', () => ({
  useBindings: () => mockUseBindings(),
  useCreateBinding: () => ({ mutate: mockCreateBindingMutate }),
  useDeleteBinding: () => ({ mutate: mockDeleteBindingMutate }),
}));

import { TopologyGraph } from '../TopologyGraph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults(overrides: {
  topology?: unknown;
  relayEnabled?: boolean;
  adapters?: unknown[];
  bindings?: unknown[];
  topologyLoading?: boolean;
  topologyError?: boolean;
} = {}) {
  mockUseTopology.mockReturnValue({
    data: overrides.topology ?? mockTopologyData,
    isLoading: overrides.topologyLoading ?? false,
    isError: overrides.topologyError ?? false,
    refetch: vi.fn(),
  });
  mockUseRelayEnabled.mockReturnValue(overrides.relayEnabled ?? true);
  mockUseRelayAdapters.mockReturnValue({
    data: overrides.adapters ?? mockAdapters,
    isLoading: false,
  });
  mockUseBindings.mockReturnValue({
    data: overrides.bindings ?? mockBindings,
    isLoading: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedReactFlowProps = {};
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TopologyGraph', () => {
  describe('adapter nodes', () => {
    it('renders adapter nodes when relay is enabled and adapters exist', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-adapter:tg-1')).toBeInTheDocument();
      expect(screen.getByTestId('node-adapter:wh-1')).toBeInTheDocument();
    });

    it('does not render adapter nodes when relay is disabled', async () => {
      setupDefaults({ relayEnabled: false, adapters: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('node-adapter:tg-1')).not.toBeInTheDocument();
    });

    it('does not render adapter nodes when no adapters exist', async () => {
      setupDefaults({ adapters: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId(/node-adapter:/)).not.toBeInTheDocument();
    });
  });

  describe('binding edges', () => {
    it('renders binding edges for existing bindings', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edge = screen.getByTestId('edge-binding:bind-1');
      expect(edge).toBeInTheDocument();
      expect(edge).toHaveAttribute('data-type', 'binding');
      expect(edge).toHaveAttribute('data-source', 'adapter:tg-1');
      expect(edge).toHaveAttribute('data-target', 'agent-1');
    });

    it('does not render binding edges when bindings are empty', async () => {
      setupDefaults({ bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId(/edge-binding:/)).not.toBeInTheDocument();
    });

    it('skips binding edges when source adapter node is missing', async () => {
      setupDefaults({
        adapters: [], // no adapter nodes -> binding source missing
        bindings: mockBindings,
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('edge-binding:bind-1')).not.toBeInTheDocument();
    });

    it('skips binding edges when target agent node is missing', async () => {
      setupDefaults({
        bindings: [{ ...mockBindings[0], agentId: 'nonexistent-agent' }],
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('edge-binding:bind-1')).not.toBeInTheDocument();
    });
  });

  describe('connection validation', () => {
    it('enables nodesConnectable when adapters exist', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(capturedReactFlowProps.nodesConnectable).toBe(true);
    });

    it('disables nodesConnectable when no adapters', async () => {
      setupDefaults({ relayEnabled: false, adapters: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(capturedReactFlowProps.nodesConnectable).toBe(false);
    });

    it('provides isValidConnection callback when adapters exist', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(capturedReactFlowProps.isValidConnection).toBeDefined();
    });
  });

  describe('empty states', () => {
    it('still shows agents when no adapters exist', async () => {
      setupDefaults({ relayEnabled: false, adapters: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-agent-1')).toBeInTheDocument();
      expect(screen.getByTestId('node-agent-2')).toBeInTheDocument();
    });

    it('shows loading state when topology is loading', () => {
      setupDefaults({ topologyLoading: true });
      render(<TopologyGraph />);

      // Should show loader, not the graph
      expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
    });

    it('shows error state on topology error', async () => {
      setupDefaults({ topologyError: true });
      render(<TopologyGraph />);

      // Wait for async layout to settle before checking error state
      await waitFor(() => {
        expect(screen.getByText('Failed to load topology')).toBeInTheDocument();
      });
    });

    it('shows empty state when no agents exist', async () => {
      setupDefaults({ topology: { namespaces: [], accessRules: [] } });
      render(<TopologyGraph />);

      // Wait for layout to settle
      await waitFor(() => {
        expect(screen.getByText('No agents discovered yet')).toBeInTheDocument();
      });
    });

    it('shows adapter hint when relay is enabled but no adapters exist', async () => {
      setupDefaults({ relayEnabled: true, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(
        screen.getByText('Add adapters from the Relay panel to connect them to agents'),
      ).toBeInTheDocument();
    });

    it('shows binding hint when adapters exist but no bindings', async () => {
      setupDefaults({ bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(
        screen.getByText('Drag from an adapter to an agent to create a binding'),
      ).toBeInTheDocument();
    });

    it('does not show hints when bindings exist', async () => {
      setupDefaults(); // default has adapters + bindings
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(
        screen.queryByText('Add adapters from the Relay panel to connect them to agents'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('Drag from an adapter to an agent to create a binding'),
      ).not.toBeInTheDocument();
    });
  });

  describe('node type registration', () => {
    it('registers adapter node type', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodeTypes = capturedReactFlowProps.nodeTypes as Record<string, unknown>;
      expect(nodeTypes).toHaveProperty('adapter');
      expect(nodeTypes).toHaveProperty('agent');
    });

    it('registers binding edge type', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edgeTypes = capturedReactFlowProps.edgeTypes as Record<string, unknown>;
      expect(edgeTypes).toHaveProperty('binding');
      expect(edgeTypes).toHaveProperty('cross-namespace');
    });
  });

  describe('adapter node data', () => {
    it('maps adapter status to running/stopped/error', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; data: Record<string, unknown> }>;
      const tgNode = nodes.find((n) => n.id === 'adapter:tg-1');
      const whNode = nodes.find((n) => n.id === 'adapter:wh-1');

      expect(tgNode?.data.adapterStatus).toBe('running');
      expect(whNode?.data.adapterStatus).toBe('stopped');
    });

    it('includes binding count per adapter', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; data: Record<string, unknown> }>;
      const tgNode = nodes.find((n) => n.id === 'adapter:tg-1');
      const whNode = nodes.find((n) => n.id === 'adapter:wh-1');

      // tg-1 has one binding, wh-1 has zero
      expect(tgNode?.data.bindingCount).toBe(1);
      expect(whNode?.data.bindingCount).toBe(0);
    });
  });

  describe('namespace group nodes (multi-namespace)', () => {
    const multiNamespaceTopology = {
      namespaces: [
        {
          namespace: 'production',
          agentCount: 1,
          agents: [
            {
              id: 'agent-prod-1',
              name: 'ProdBuilder',
              runtime: 'claude-code',
              capabilities: ['deploy'],
              healthStatus: 'active',
              dir: '/projects/prod',
            },
          ],
        },
        {
          namespace: 'staging',
          agentCount: 1,
          agents: [
            {
              id: 'agent-stg-1',
              name: 'StageTester',
              runtime: 'claude-code',
              capabilities: ['test'],
              healthStatus: 'stale',
              dir: '/projects/staging',
            },
          ],
        },
      ],
      accessRules: [
        { sourceNamespace: 'staging', targetNamespace: 'production', action: 'allow' },
        { sourceNamespace: 'production', targetNamespace: 'staging', action: 'deny' },
      ],
    };

    it('creates namespace-group nodes for multi-namespace topologies', async () => {
      setupDefaults({ topology: multiNamespaceTopology, relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-group:production')).toBeInTheDocument();
      expect(screen.getByTestId('node-group:staging')).toBeInTheDocument();
    });

    it('sets parentId on agent nodes in multi-namespace topologies', async () => {
      setupDefaults({ topology: multiNamespaceTopology, relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; parentId?: string; extent?: string }>;
      const prodAgent = nodes.find((n) => n.id === 'agent-prod-1');
      const stgAgent = nodes.find((n) => n.id === 'agent-stg-1');

      expect(prodAgent?.parentId).toBe('group:production');
      expect(prodAgent?.extent).toBe('parent');
      expect(stgAgent?.parentId).toBe('group:staging');
      expect(stgAgent?.extent).toBe('parent');
    });

    it('does not create namespace-group nodes for single-namespace topologies', async () => {
      setupDefaults({ relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; type: string }>;
      const groupNodes = nodes.filter((n) => n.type === 'namespace-group');
      expect(groupNodes).toHaveLength(0);
    });

    it('does not set parentId on agent nodes in single-namespace topologies', async () => {
      setupDefaults({ relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; parentId?: string }>;
      const agentNodes = nodes.filter((n) => !n.id.startsWith('group:') && !n.id.startsWith('adapter:'));
      for (const agent of agentNodes) {
        expect(agent.parentId).toBeUndefined();
      }
    });

    it('creates no spoke edges — agents are visually inside groups', async () => {
      setupDefaults({ topology: multiNamespaceTopology, relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edges = capturedReactFlowProps.edges as Array<{ id: string; type: string }>;
      // No namespace-internal (spoke) edges should exist
      const spokeEdges = edges.filter((e) => e.type === 'namespace-internal');
      expect(spokeEdges).toHaveLength(0);
    });

    it('creates cross-namespace edges connecting group nodes', async () => {
      setupDefaults({ topology: multiNamespaceTopology, relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edges = capturedReactFlowProps.edges as Array<{
        id: string;
        type: string;
        source: string;
        target: string;
      }>;
      const crossEdges = edges.filter((e) => e.type === 'cross-namespace');
      const denyEdges = edges.filter((e) => e.type === 'cross-namespace-deny');

      expect(crossEdges).toHaveLength(1);
      expect(crossEdges[0].source).toBe('group:staging');
      expect(crossEdges[0].target).toBe('group:production');

      expect(denyEdges).toHaveLength(1);
      expect(denyEdges[0].source).toBe('group:production');
      expect(denyEdges[0].target).toBe('group:staging');
    });

    it('registers namespace-group in node types', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodeTypes = capturedReactFlowProps.nodeTypes as Record<string, unknown>;
      expect(nodeTypes).toHaveProperty('namespace-group');
    });
  });
});
