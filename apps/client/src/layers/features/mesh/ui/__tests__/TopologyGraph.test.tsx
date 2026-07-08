/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
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
    const edges = props.edges as Array<{
      id: string;
      type: string;
      source: string;
      target: string;
    }>;
    return (
      <div data-testid="react-flow">
        {nodes?.map((n) => (
          <div key={n.id} data-testid={`node-${n.id}`} data-type={n.type}>
            {String(
              (n.data as Record<string, unknown>).label ??
                (n.data as Record<string, unknown>).adapterName ??
                n.id
            )}
          </div>
        ))}
        {edges?.map((e) => (
          <div
            key={e.id}
            data-testid={`edge-${e.id}`}
            data-type={e.type}
            data-source={e.source}
            data-target={e.target}
          />
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
// BindingDialog now lives in entities/binding; its mock is defined in that
// module's mock below. Props are captured here for assertions.
let capturedBindingDialogProps: Record<string, unknown> = {};

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
          projectPath: '/projects/builder',
        },
        {
          id: 'agent-2',
          name: 'Writer',
          runtime: 'claude-code',
          capabilities: ['docs'],
          healthStatus: 'stale',
          projectPath: '/projects/writer',
        },
      ],
    },
  ],
  accessRules: [],
};

const mockAdapters = [
  {
    config: { id: 'cca-1', type: 'claude-code', enabled: true, config: {} },
    status: {
      id: 'cca-1',
      type: 'claude-code',
      displayName: 'Claude Code',
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
  },
  {
    config: { id: 'tg-1', type: 'telegram', enabled: true, label: '@support_bot', config: {} },
    status: {
      id: 'tg-1',
      type: 'telegram',
      displayName: 'Telegram Bot',
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
  },
  {
    config: { id: 'wh-1', type: 'webhook', enabled: true, config: {} },
    status: {
      id: 'wh-1',
      type: 'webhook',
      displayName: 'Webhook Inbound',
      state: 'disconnected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
  },
];

const mockBindings = [
  {
    id: 'bind-1',
    adapterId: 'tg-1',
    agentId: 'agent-1',
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

vi.mock('@/layers/entities/binding', async () => {
  // Keep the real mapper — the create-flow regression asserts the exact payload.
  const bindingForm = await vi.importActual<
    typeof import('@/layers/entities/binding/model/binding-form')
  >('@/layers/entities/binding/model/binding-form');
  return {
    useBindings: () => mockUseBindings(),
    useCreateBinding: () => ({ mutate: mockCreateBindingMutate }),
    useDeleteBinding: () => ({ mutate: mockDeleteBindingMutate }),
    toCreateBindingRequest: bindingForm.toCreateBindingRequest,
    BindingDialog: (props: {
      open: boolean;
      mode?: string;
      initialValues?: { adapterId?: string; agentId?: string };
      onConfirm: (values: Record<string, unknown>) => void;
    }) => {
      capturedBindingDialogProps = props;
      return props.open ? (
        <div data-testid="binding-dialog">
          <button
            data-testid="dialog-confirm"
            onClick={() =>
              props.onConfirm({
                adapterId: props.initialValues?.adapterId,
                agentId: props.initialValues?.agentId,
                sessionStrategy: 'per-user',
                label: 'From graph',
                permissionMode: 'plan',
                chatId: 'chat-42',
                channelType: 'group',
                canInitiate: true,
                canReply: true,
                canReceive: false,
              })
            }
          >
            Confirm
          </button>
        </div>
      ) : null;
    },
  };
});

import { TopologyGraph } from '../TopologyGraph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults(
  overrides: {
    topology?: unknown;
    relayEnabled?: boolean;
    adapters?: unknown[];
    bindings?: unknown[];
    topologyLoading?: boolean;
    topologyError?: boolean;
  } = {}
) {
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
  capturedBindingDialogProps = {};
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
        screen.getByText('Add adapters from the Relay panel to connect them to agents')
      ).toBeInTheDocument();
    });

    it('shows binding hint when adapters exist but no bindings', async () => {
      setupDefaults({ bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByText('Drag from a channel to an agent to connect it')).toBeInTheDocument();
    });

    it('does not show hints when bindings exist', async () => {
      setupDefaults(); // default has adapters + bindings
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(
        screen.queryByText('Add adapters from the Relay panel to connect them to agents')
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('Drag from a channel to an agent to connect it')
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

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
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

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
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
              projectPath: '/projects/prod',
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
              projectPath: '/projects/staging',
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
      setupDefaults({
        topology: multiNamespaceTopology,
        relayEnabled: false,
        adapters: [],
        bindings: [],
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-group:production')).toBeInTheDocument();
      expect(screen.getByTestId('node-group:staging')).toBeInTheDocument();
    });

    it('sets parentId on agent nodes in multi-namespace topologies', async () => {
      setupDefaults({
        topology: multiNamespaceTopology,
        relayEnabled: false,
        adapters: [],
        bindings: [],
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        parentId?: string;
        extent?: string;
      }>;
      const prodAgent = nodes.find((n) => n.id === 'agent-prod-1');
      const stgAgent = nodes.find((n) => n.id === 'agent-stg-1');

      expect(prodAgent?.parentId).toBe('group:production');
      expect(prodAgent?.extent).toBe('parent');
      expect(stgAgent?.parentId).toBe('group:staging');
      expect(stgAgent?.extent).toBe('parent');
    });

    it('creates namespace-group node for single-namespace topologies', async () => {
      setupDefaults({ relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; type: string }>;
      const groupNodes = nodes.filter((n) => n.type === 'namespace-group');
      expect(groupNodes).toHaveLength(1);
      expect(groupNodes[0].id).toBe('group:default');
    });

    it('sets parentId on agent nodes in single-namespace topologies', async () => {
      setupDefaults({ relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{ id: string; parentId?: string }>;
      const agentNodes = nodes.filter(
        (n) => !n.id.startsWith('group:') && !n.id.startsWith('adapter:')
      );
      for (const agent of agentNodes) {
        expect(agent.parentId).toBe('group:default');
      }
    });

    it('creates no spoke edges — agents are visually inside groups', async () => {
      setupDefaults({
        topology: multiNamespaceTopology,
        relayEnabled: false,
        adapters: [],
        bindings: [],
      });
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
      setupDefaults({
        topology: multiNamespaceTopology,
        relayEnabled: false,
        adapters: [],
        bindings: [],
      });
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

  describe('CCA adapter filtering', () => {
    it('does not render CCA adapter as a graph node', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      // CCA should be filtered out
      expect(screen.queryByTestId('node-adapter:cca-1')).not.toBeInTheDocument();
      // External adapters should still render
      expect(screen.getByTestId('node-adapter:tg-1')).toBeInTheDocument();
      expect(screen.getByTestId('node-adapter:wh-1')).toBeInTheDocument();
    });

    it('excludes CCA binding edges because source node is filtered', async () => {
      setupDefaults({
        bindings: [
          ...mockBindings,
          {
            id: 'bind-cca',
            adapterId: 'cca-1',
            agentId: 'agent-1',
            sessionStrategy: 'per-chat' as const,
            label: '',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('edge-binding:bind-cca')).not.toBeInTheDocument();
      expect(screen.getByTestId('edge-binding:bind-1')).toBeInTheDocument();
    });
  });

  describe('ghost adapter placeholder', () => {
    it('renders ghost adapter node when relay enabled and only CCA adapters exist', async () => {
      const ccaOnly = [mockAdapters[0]]; // Just CCA
      setupDefaults({ adapters: ccaOnly, bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-ghost-adapter')).toBeInTheDocument();
    });

    it('renders ghost adapter node when relay enabled and no adapters at all', async () => {
      setupDefaults({ adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.getByTestId('node-ghost-adapter')).toBeInTheDocument();
    });

    it('does not render ghost adapter when external adapters exist', async () => {
      setupDefaults(); // Default includes telegram + webhook
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('node-ghost-adapter')).not.toBeInTheDocument();
    });

    it('does not render ghost adapter when relay is disabled', async () => {
      setupDefaults({ relayEnabled: false, adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('node-ghost-adapter')).not.toBeInTheDocument();
    });

    it('ghost adapter node has isGhost flag in data', async () => {
      setupDefaults({ adapters: [], bindings: [] });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
      const ghostNode = nodes.find((n) => n.id === 'ghost-adapter');
      expect(ghostNode?.data.isGhost).toBe(true);
      expect(ghostNode?.data.adapterName).toBe('Add Adapter');
    });
  });

  describe('adapter label data', () => {
    it('passes adapter label to node data when present', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
      const tgNode = nodes.find((n) => n.id === 'adapter:tg-1');
      expect(tgNode?.data.label).toBe('@support_bot');
    });

    it('does not set label when adapter config has no label', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const nodes = capturedReactFlowProps.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
      const whNode = nodes.find((n) => n.id === 'adapter:wh-1');
      expect(whNode?.data.label).toBeUndefined();
    });
  });

  describe('binding edge filter data', () => {
    it('passes chatId and channelType to binding edge data', async () => {
      setupDefaults({
        bindings: [
          {
            ...mockBindings[0],
            chatId: '12345',
            channelType: 'private',
          },
        ],
      });
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edges = capturedReactFlowProps.edges as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
      const bindingEdge = edges.find((e) => e.id === 'binding:bind-1');
      expect(bindingEdge?.data?.chatId).toBe('12345');
      expect(bindingEdge?.data?.channelType).toBe('private');
    });

    it('does not set chatId/channelType when not present on binding', async () => {
      setupDefaults(); // Default binding has no chatId or channelType
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const edges = capturedReactFlowProps.edges as Array<{
        id: string;
        data: Record<string, unknown>;
      }>;
      const bindingEdge = edges.find((e) => e.id === 'binding:bind-1');
      expect(bindingEdge?.data?.chatId).toBeUndefined();
      expect(bindingEdge?.data?.channelType).toBeUndefined();
    });
  });

  describe('drag-to-bind create flow', () => {
    function connect(source: string, target: string) {
      const onConnect = capturedReactFlowProps.onConnect as (connection: {
        source: string;
        target: string;
        sourceHandle: string | null;
        targetHandle: string | null;
      }) => void;
      act(() => {
        onConnect({ source, target, sourceHandle: null, targetHandle: null });
      });
    }

    it('opens the dialog in create mode pre-filled with the dragged adapter and agent', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      connect('adapter:tg-1', 'agent-1');

      expect(screen.getByTestId('binding-dialog')).toBeInTheDocument();
      expect(capturedBindingDialogProps.mode).toBe('create');
      expect(capturedBindingDialogProps.initialValues).toEqual({
        adapterId: 'tg-1',
        agentId: 'agent-1',
      });
    });

    it('forwards the full form values to the create mutation (UX2 regression)', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      connect('adapter:tg-1', 'agent-1');
      fireEvent.click(screen.getByTestId('dialog-confirm'));

      // Everything the user configured must reach the mutation — permission
      // mode, chat filter, and direction toggles were previously dropped.
      expect(mockCreateBindingMutate).toHaveBeenCalledWith({
        adapterId: 'tg-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-user',
        label: 'From graph',
        permissionMode: 'plan',
        chatId: 'chat-42',
        channelType: 'group',
        canInitiate: true,
        canReply: true,
        canReceive: false,
      });
      // Dialog closes after confirm.
      expect(screen.queryByTestId('binding-dialog')).not.toBeInTheDocument();
    });
  });

  describe('drag-to-connect visual state', () => {
    it('applies is-connecting alongside inset-0 during a connect gesture (UX4 regression)', async () => {
      setupDefaults();
      const { container } = render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      const topologyContainer = container.querySelector('.topology-container') as HTMLElement;
      expect(topologyContainer.classList.contains('inset-0')).toBe(true);
      expect(topologyContainer.classList.contains('is-connecting')).toBe(false);

      const onConnectStart = capturedReactFlowProps.onConnectStart as (
        event: MouseEvent,
        params: { nodeId: string | null }
      ) => void;
      act(() => {
        onConnectStart(new MouseEvent('mousedown'), { nodeId: 'adapter:tg-1' });
      });

      // The missing-space bug produced `inset-0is-connecting`: no connect
      // feedback AND a collapsed container mid-gesture.
      expect(topologyContainer.classList.contains('is-connecting')).toBe(true);
      expect(topologyContainer.classList.contains('inset-0')).toBe(true);

      const onConnectEnd = capturedReactFlowProps.onConnectEnd as () => void;
      act(() => {
        onConnectEnd();
      });
      expect(topologyContainer.classList.contains('is-connecting')).toBe(false);
    });
  });

  describe('backspace-safe edge deletion', () => {
    /** Simulate ReactFlow reporting a `remove` change for a binding edge. */
    function removeEdge(id: string) {
      const onEdgesChange = capturedReactFlowProps.onEdgesChange as (
        changes: Array<{ type: string; id: string }>
      ) => void;
      act(() => {
        onEdgesChange([{ type: 'remove', id }]);
      });
    }

    it('disables the native delete key so nodes/edges are never removed silently', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(capturedReactFlowProps.deleteKeyCode).toBeNull();
    });

    it('routes an edge removal through a confirm dialog instead of deleting immediately', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      removeEdge('binding:bind-1');

      // Confirm dialog is shown; nothing is deleted yet.
      expect(
        screen.getByText('Remove this channel? The agent will no longer receive messages from it.')
      ).toBeInTheDocument();
      expect(mockDeleteBindingMutate).not.toHaveBeenCalled();
    });

    it('deletes the binding (by UUID) when the removal is confirmed', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      removeEdge('binding:bind-1');
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      // The "binding:" prefix is stripped before hitting the mutation.
      expect(mockDeleteBindingMutate).toHaveBeenCalledWith('bind-1');
    });

    it('does not delete when the removal is cancelled', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      removeEdge('binding:bind-1');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockDeleteBindingMutate).not.toHaveBeenCalled();
    });
  });

  describe('viewport-preserving re-layout', () => {
    it('keeps the ReactFlow canvas mounted across a structural change', async () => {
      setupDefaults();
      const { rerender } = render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      // Add a third agent — this triggers a fresh ELK layout pass.
      mockUseTopology.mockReturnValue({
        data: {
          namespaces: [
            {
              ...mockTopologyData.namespaces[0],
              agentCount: 3,
              agents: [
                ...mockTopologyData.namespaces[0].agents,
                {
                  id: 'agent-3',
                  name: 'Reviewer',
                  runtime: 'claude-code',
                  capabilities: ['review'],
                  healthStatus: 'active',
                  projectPath: '/projects/reviewer',
                },
              ],
            },
          ],
          accessRules: [],
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      rerender(<TopologyGraph />);

      // The canvas must NOT unmount during the re-layout — otherwise the
      // viewport, zoom, and selection would reset. It stays in the DOM because
      // the previous layouted nodes are retained while ELK recomputes.
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByTestId('node-agent-3')).toBeInTheDocument();
      });
      expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    });
  });
});
