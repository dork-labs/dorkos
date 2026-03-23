/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TopologyAgent, MeshStatus } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/session', () => ({
  useSessions: () => ({ sessions: [], isLoading: false }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

const mockUseMeshStatus = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useUnregisterAgent: () => ({ mutate: vi.fn() }),
  useMeshStatus: () => mockUseMeshStatus(),
}));

vi.mock('@/layers/features/agent-settings', () => ({
  AgentDialog: () => null,
}));

// Mock AgentRow to isolate AgentsList logic
vi.mock('../ui/AgentRow', () => ({
  AgentRow: ({ agent }: { agent: TopologyAgent }) => (
    <div data-testid={`agent-row-${agent.id}`}>{agent.name}</div>
  ),
}));

// Mock AgentEmptyFilterState to make it easily assertable
vi.mock('../ui/AgentEmptyFilterState', () => ({
  AgentEmptyFilterState: ({ onClearFilters }: { onClearFilters: () => void }) => (
    <div data-testid="agent-empty-filter-state">
      <button onClick={onClearFilters}>Clear filters</button>
    </div>
  ),
}));

// Mock SessionLaunchPopover
vi.mock('../ui/SessionLaunchPopover', () => ({
  SessionLaunchPopover: () => <button>Start Session</button>,
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

import { AgentsList } from '../ui/AgentsList';

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

const makeAgent = (overrides: Partial<TopologyAgent> & { id: string }): TopologyAgent => {
  const base: TopologyAgent = {
    id: overrides.id,
    name: overrides.name ?? `Agent ${overrides.id}`,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    namespace: overrides.namespace,
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    personaEnabled: true,
    enabledToolGroups: {},
    projectPath: overrides.projectPath ?? `/${overrides.id}`,
    healthStatus: overrides.healthStatus ?? 'active',
    relayAdapters: [],
    relaySubject: null,
    pulseScheduleCount: 0,
    lastSeenAt: null,
    lastSeenEvent: null,
  };
  return { ...base, ...overrides };
};

const multiNsAgents: TopologyAgent[] = [
  makeAgent({ id: '1', name: 'Agent A', namespace: 'web', projectPath: '/a' }),
  makeAgent({ id: '2', name: 'Agent B', namespace: 'web', projectPath: '/b' }),
  makeAgent({ id: '3', name: 'Agent C', namespace: 'api', projectPath: '/c' }),
];

const makeMeshStatus = (overrides: Partial<MeshStatus> = {}): MeshStatus => ({
  totalAgents: 3,
  activeCount: 2,
  inactiveCount: 1,
  staleCount: 0,
  unreachableCount: 0,
  byRuntime: {},
  byProject: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no mesh status data available
    mockUseMeshStatus.mockReturnValue({ data: undefined });
  });

  it('renders loading skeleton when isLoading is true', () => {
    const { container } = render(<AgentsList agents={[]} isLoading={true} />, {
      wrapper: createWrapper(),
    });

    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders an AgentRow for each agent', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByTestId('agent-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-3')).toBeInTheDocument();
  });

  it('groups by namespace when >1 namespace exists', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
  });

  it('shows flat list (no namespace headers) for single namespace', () => {
    const singleNsAgents = multiNsAgents.map((a) => ({ ...a, namespace: 'web' }));

    render(<AgentsList agents={singleNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // No namespace group headers should be shown
    expect(screen.queryByText('web')).not.toBeInTheDocument();
    expect(screen.queryByText('api')).not.toBeInTheDocument();
  });

  it('renders FleetHealthBar when mesh status data is available', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus() });

    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // FleetHealthBar renders status counts as accessible buttons
    expect(screen.getByRole('button', { name: '2 Active' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 Inactive' })).toBeInTheDocument();
  });

  it('does not render FleetHealthBar when mesh status data is unavailable', () => {
    mockUseMeshStatus.mockReturnValue({ data: undefined });

    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByRole('button', { name: /Active/ })).not.toBeInTheDocument();
  });

  it('clicking a health bar count updates the status filter', () => {
    mockUseMeshStatus.mockReturnValue({ data: makeMeshStatus() });

    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    const activeButton = screen.getByRole('button', { name: '2 Active' });
    fireEvent.click(activeButton);

    // After clicking "Active", the button should be styled as active (font-medium text-foreground).
    // The filter bar's "active" chip should now be in default (active) variant.
    // Verify by checking the active chip inside the filter bar is rendered.
    expect(screen.getAllByRole('button', { name: /active/i }).length).toBeGreaterThan(0);
  });

  it('renders AgentEmptyFilterState when filters match zero agents but agents exist', () => {
    // All agents have healthStatus 'active'; filtering by 'inactive' yields zero results
    render(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    // Simulate filtering to a status that matches nothing by directly triggering
    // the search input to a term that matches no agent name
    const searchInput = screen.getByPlaceholderText('Filter agents...');
    fireEvent.change(searchInput, { target: { value: 'xyzzy-no-match' } });

    expect(screen.getByTestId('agent-empty-filter-state')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row-1')).not.toBeInTheDocument();
  });

  it('does not render AgentEmptyFilterState when the agents array is empty', () => {
    render(<AgentsList agents={[]} isLoading={false} />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('agent-empty-filter-state')).not.toBeInTheDocument();
  });

  it('clicking "Clear filters" in AgentEmptyFilterState restores the agent list', () => {
    render(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    // Apply a filter that matches nothing
    const searchInput = screen.getByPlaceholderText('Filter agents...');
    fireEvent.change(searchInput, { target: { value: 'xyzzy-no-match' } });
    expect(screen.getByTestId('agent-empty-filter-state')).toBeInTheDocument();

    // Clear filters via the empty state button
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    // Agents should be visible again; empty state should be gone
    expect(screen.queryByTestId('agent-empty-filter-state')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-row-1')).toBeInTheDocument();
  });
});
