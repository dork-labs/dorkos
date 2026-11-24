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

// Mock ELK layout — returns nodes with position set to { x: 0, y: 0 }, or
// refuses the graph while `elkRefuses` is set (a real ELK throws on an edge to
// a node that does not exist).
let elkRefuses = false;
vi.mock('elkjs/lib/elk.bundled.js', () => {
  return {
    default: class MockELK {
      async layout(graph: { children?: Array<{ id: string; children?: Array<{ id: string }> }> }) {
        if (elkRefuses) throw new Error('Referenced shape does not exist: group:*');
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
// Mock the relay-flow SSE bridge — it calls useEventSubscription, which
// requires an EventStreamProvider this suite does not wrap TopologyGraph in.
// The bridge itself is unit-tested directly in use-relay-flow-subscription.test.ts.
const mockUseRelayFlowSubscription = vi.fn();
vi.mock('../../model/use-relay-flow-subscription', () => ({
  useRelayFlowSubscription: (enabled: boolean) => mockUseRelayFlowSubscription(enabled),
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
  elkRefuses = false;
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
        expect(screen.getByText(/Couldn’t draw the map of your agents/)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('says the map could not be drawn when the layout is refused, never a blank canvas', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      elkRefuses = true;
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByText(/Couldn’t draw the map of your agents/)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();

      // Retry runs the layout again, and a layout that works draws the agents.
      elkRefuses = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(screen.getByTestId('node-agent-1')).toBeInTheDocument();
      });
    });

    it('says everyone can message everyone only while the open-mesh rule is on', async () => {
      setupDefaults({ topology: { ...mockTopologyData, openMesh: true } });
      const { unmount } = render(<TopologyGraph />);
      await waitFor(() => {
        expect(screen.getByText('Everyone can message everyone')).toBeInTheDocument();
      });
      unmount();

      setupDefaults();
      render(<TopologyGraph />);
      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });
      expect(screen.queryByText('Everyone can message everyone')).not.toBeInTheDocument();
    });

    it('shows empty state when no agents exist', async () => {
      setupDefaults({ topology: { namespaces: [], accessRules: [] } });
      render(<TopologyGraph />);

      // Wait for layout to settle
      await waitFor(() => {
        expect(screen.getByText('No agents found yet')).toBeInTheDocument();
      });
    });

    it('hides the drag hint on a touch screen, where dragging is not how you connect', async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        ...original(query),
        matches: query === '(pointer: coarse)',
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as typeof window.matchMedia;
      try {
        setupDefaults({ bindings: [] });
        render(<TopologyGraph />);
        await waitFor(() => {
          expect(screen.getByTestId('react-flow')).toBeInTheDocument();
        });
        expect(
          screen.queryByText('Drag from a platform to an agent to connect them')
        ).not.toBeInTheDocument();
      } finally {
        window.matchMedia = original;
      }
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

    it('does not render ghost adapter when external adapters exist', async () => {
      setupDefaults(); // Default includes telegram + webhook
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('node-ghost-adapter')).not.toBeInTheDocument();
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
      expect(screen.getByText('The agent stops getting messages from it.')).toBeInTheDocument();
      expect(mockDeleteBindingMutate).not.toHaveBeenCalled();
    });

    it('deletes the binding (by UUID) when the removal is confirmed', async () => {
      setupDefaults();
      render(<TopologyGraph />);

      await waitFor(() => {
        expect(screen.getByTestId('react-flow')).toBeInTheDocument();
      });

      removeEdge('binding:bind-1');
      fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));

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

      const canvasBeforeRelayout = screen.getByTestId('react-flow');

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
      // viewport, zoom, and selection would reset. Element identity proves the
      // same mounted instance survives (an unmount + remount would create a
      // new DOM node even though the testid still matches).
      expect(screen.getByTestId('react-flow')).toBe(canvasBeforeRelayout);

      await waitFor(() => {
        expect(screen.getByTestId('node-agent-3')).toBeInTheDocument();
      });
      expect(screen.getByTestId('react-flow')).toBe(canvasBeforeRelayout);
    });
  });
});
