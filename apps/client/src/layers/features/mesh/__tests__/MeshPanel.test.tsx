/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseMeshEnabled = vi.fn().mockReturnValue(false);
const mockUseRegisteredAgents = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseDiscoverAgents = vi.fn().mockReturnValue({ mutate: vi.fn(), data: undefined, isPending: false });
const mockUseDeniedAgents = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseUnregisterAgent = vi.fn().mockReturnValue({ mutate: vi.fn() });
const mockUseMeshStatus = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseMeshAgentHealth = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseTopology = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseUpdateAccessRule = vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false });

vi.mock('@/layers/entities/mesh', () => ({
  useMeshEnabled: (...args: unknown[]) => mockUseMeshEnabled(...args),
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
  useDiscoverAgents: (...args: unknown[]) => mockUseDiscoverAgents(...args),
  useDeniedAgents: (...args: unknown[]) => mockUseDeniedAgents(...args),
  useUnregisterAgent: (...args: unknown[]) => mockUseUnregisterAgent(...args),
  useMeshStatus: (...args: unknown[]) => mockUseMeshStatus(...args),
  useMeshAgentHealth: (...args: unknown[]) => mockUseMeshAgentHealth(...args),
  useTopology: (...args: unknown[]) => mockUseTopology(...args),
  useUpdateAccessRule: (...args: unknown[]) => mockUseUpdateAccessRule(...args),
}));

// ---------------------------------------------------------------------------
// Mock @radix-ui/react-tabs to render all tab panels simultaneously.
// This avoids concurrent-mode transition issues with lazy/Suspense while
// still allowing tab trigger clicks to be verified via data-value attributes.
// ---------------------------------------------------------------------------

vi.mock('@radix-ui/react-tabs', () => ({
  Root: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  List: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <div role="tablist" {...props}>{children}</div>
  ),
  Trigger: ({
    children,
    value,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode; value?: string }) => (
    <button role="tab" data-value={value} {...props}>{children}</button>
  ),
  Content: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <div role="tabpanel" {...props}>{children}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock lazy-loaded TopologyGraph to avoid ReactFlow / dagre setup in tests.
// ---------------------------------------------------------------------------

vi.mock('../ui/TopologyGraph', () => ({
  TopologyGraph: ({ onSelectAgent }: { onSelectAgent?: (id: string) => void }) => (
    <div data-testid="topology-graph" onClick={() => onSelectAgent?.('agent-1')} />
  ),
}));


import { MeshPanel } from '../ui/MeshPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function enableMesh() {
  mockUseMeshEnabled.mockReturnValue(true);
  mockUseRegisteredAgents.mockReturnValue({ data: { agents: [] }, isLoading: false });
  mockUseDeniedAgents.mockReturnValue({ data: { denied: [] }, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMeshEnabled.mockReturnValue(false);
  mockUseRegisteredAgents.mockReturnValue({ data: undefined, isLoading: false });
  mockUseDiscoverAgents.mockReturnValue({ mutate: vi.fn(), data: undefined, isPending: false });
  mockUseDeniedAgents.mockReturnValue({ data: undefined, isLoading: false });
  mockUseUnregisterAgent.mockReturnValue({ mutate: vi.fn() });
  mockUseMeshStatus.mockReturnValue({ data: undefined, isLoading: false });
  mockUseMeshAgentHealth.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Disabled state
// ---------------------------------------------------------------------------

describe('MeshPanel - disabled state', () => {
  it('renders disabled message when mesh is disabled', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.getByText('Mesh is not enabled')).toBeInTheDocument();
  });

  it('shows the enable hint', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.getByText('DORKOS_MESH_ENABLED=true dorkos')).toBeInTheDocument();
  });

  it('does not render any tabs when disabled', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Enabled state - tabs render
// ---------------------------------------------------------------------------

describe('MeshPanel - enabled state', () => {
  beforeEach(enableMesh);

  it('renders all 5 tabs', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.getByRole('tab', { name: 'Topology' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Discovery' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Denied' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Access' })).toBeInTheDocument();
  });

  it('has Topology as the default tab value', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    // The Radix mock passes defaultValue through to the root div; verify the
    // Topology trigger is first in the tablist and has the correct value.
    const tablist = screen.getByRole('tablist');
    const firstTab = tablist.querySelector('[role="tab"]');
    expect(firstTab).toHaveTextContent('Topology');
    expect(firstTab).toHaveAttribute('data-value', 'topology');
  });

  it('does not show disabled message', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.queryByText('Mesh is not enabled')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Topology tab (default active tab — content is visible)
// ---------------------------------------------------------------------------

describe('MeshPanel - Topology tab', () => {
  beforeEach(enableMesh);

  it('renders the topology graph when Topology tab is active', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.getByTestId('topology-graph')).toBeInTheDocument();
  });

  it('does not show the agent health detail panel initially', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    expect(screen.queryByLabelText('Close detail panel')).not.toBeInTheDocument();
  });

  it('shows the agent health detail panel when an agent node is clicked', () => {
    mockUseMeshAgentHealth.mockReturnValue({ data: undefined, isLoading: true });
    render(<MeshPanel />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('topology-graph'));
    // AgentHealthDetail renders while loading
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Discovery tab (now secondary — must click to activate)
// ---------------------------------------------------------------------------

describe('MeshPanel - Discovery tab', () => {
  beforeEach(enableMesh);

  // With the @radix-ui/react-tabs mock, all tab panels render simultaneously.
  // This helper click is kept for semantic clarity but has no functional effect.
  function activateDiscoveryTab() {
    fireEvent.click(screen.getByRole('tab', { name: 'Discovery' }));
  }

  it('shows scan input and button', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    expect(screen.getByPlaceholderText(/Roots to scan/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan/ })).toBeInTheDocument();
  });

  it('disables Scan button when input is empty', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    expect(screen.getByRole('button', { name: /Scan/ })).toBeDisabled();
  });

  it('enables Scan button when input has text', () => {
    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    fireEvent.change(screen.getByPlaceholderText(/Roots to scan/), {
      target: { value: '~/projects' },
    });
    expect(screen.getByRole('button', { name: /Scan/ })).not.toBeDisabled();
  });

  it('shows empty results message when scan returns no candidates', () => {
    mockUseDiscoverAgents.mockReturnValue({
      mutate: vi.fn(),
      data: { candidates: [] },
      isPending: false,
    });

    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    expect(
      screen.getByText('No agents discovered. Try scanning different directories.')
    ).toBeInTheDocument();
  });

  it('renders candidate cards when discovery returns results', () => {
    mockUseDiscoverAgents.mockReturnValue({
      mutate: vi.fn(),
      data: {
        candidates: [
          {
            path: '/opt/agents/coder',
            hints: {
              suggestedName: 'Coder',
              detectedRuntime: 'claude-code',
              description: 'A coding agent',
              inferredCapabilities: ['code', 'debug'],
            },
          },
        ],
      },
      isPending: false,
    });

    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    expect(screen.getByText('Coder')).toBeInTheDocument();
    expect(screen.getByText('/opt/agents/coder')).toBeInTheDocument();
    expect(screen.getByText('A coding agent')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(screen.getByText('debug')).toBeInTheDocument();
  });

  it('calls discover mutation with parsed roots on scan', () => {
    const mockMutate = vi.fn();
    mockUseDiscoverAgents.mockReturnValue({
      mutate: mockMutate,
      data: undefined,
      isPending: false,
    });

    render(<MeshPanel />, { wrapper: createWrapper() });
    activateDiscoveryTab();
    fireEvent.change(screen.getByPlaceholderText(/Roots to scan/), {
      target: { value: '~/projects, /opt/agents' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Scan/ }));

    expect(mockMutate).toHaveBeenCalledWith({ roots: ['~/projects', '/opt/agents'] });
  });
});
