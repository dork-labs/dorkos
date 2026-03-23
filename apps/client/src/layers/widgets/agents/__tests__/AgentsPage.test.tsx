/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRefetch = vi.fn();
const mockUseTopology = vi.fn();
let mockViewMode: 'list' | 'topology' = 'list';

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ view: mockViewMode }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useTopology: () => mockUseTopology(),
}));

vi.mock('@/layers/features/agents-list', () => ({
  AgentsList: ({ agents }: { agents: unknown[] }) => (
    <div data-testid="agents-list" data-count={agents.length}>
      AgentsList
    </div>
  ),
  AgentGhostRows: () => <div data-testid="agent-ghost-rows">AgentGhostRows</div>,
}));

vi.mock('@/layers/features/mesh/ui/TopologyGraph', () => ({
  TopologyGraph: () => <div data-testid="topology-graph">TopologyGraph</div>,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { AgentsPage } from '../ui/AgentsPage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const makeTopologyResult = (agentCount: number) => ({
  namespaces:
    agentCount > 0
      ? [
          {
            namespace: 'web',
            agentCount,
            agents: Array.from({ length: agentCount }, (_, i) => ({
              id: `agent-${i + 1}`,
              name: `Agent ${i + 1}`,
              description: '',
              runtime: 'claude-code',
              capabilities: [],
              behavior: { responseMode: 'always' },
              budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
              namespace: 'web',
              registeredAt: new Date().toISOString(),
              registeredBy: 'user',
              personaEnabled: true,
              enabledToolGroups: {},
              projectPath: `/project-${i + 1}`,
              healthStatus: 'active',
              relayAdapters: [],
              relaySubject: null,
              pulseScheduleCount: 0,
              lastSeenAt: null,
              lastSeenEvent: null,
            })),
          },
        ]
      : [],
});

afterEach(() => {
  cleanup();
  mockViewMode = 'list';
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefetch.mockResolvedValue(undefined);
  });

  it('renders AgentGhostRows in Mode A when zero agents', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyResult(0),
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    expect(screen.getByTestId('agent-ghost-rows')).toBeInTheDocument();
    expect(screen.queryByTestId('agents-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topology-graph')).not.toBeInTheDocument();
  });

  it('does not render the Tabs component in Mode A', () => {
    mockUseTopology.mockReturnValue({
      data: makeTopologyResult(0),
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders AgentsList in Mode B when viewMode is list', () => {
    mockViewMode = 'list';
    mockUseTopology.mockReturnValue({
      data: makeTopologyResult(3),
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    expect(screen.getByTestId('agents-list')).toBeInTheDocument();
    expect(screen.queryByTestId('topology-graph')).not.toBeInTheDocument();
  });

  it('renders TopologyGraph in Mode B when viewMode is topology', async () => {
    mockViewMode = 'topology';
    mockUseTopology.mockReturnValue({
      data: makeTopologyResult(2),
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    // LazyTopologyGraph is behind Suspense — wait for the lazy import to resolve.
    await waitFor(() => expect(screen.getByTestId('topology-graph')).toBeInTheDocument());
    expect(screen.queryByTestId('agents-list')).not.toBeInTheDocument();
  });

  it('does not render Tabs in Mode B', () => {
    mockViewMode = 'list';
    mockUseTopology.mockReturnValue({
      data: makeTopologyResult(2),
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders error state with retry button on isError', () => {
    mockUseTopology.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    expect(screen.getByText(/could not load agents/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('calls refetch on retry button click', () => {
    mockUseTopology.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    });

    render(<AgentsPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(mockRefetch).toHaveBeenCalled();
  });
});
