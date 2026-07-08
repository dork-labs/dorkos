/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks — URL search state is simulated via a mutable record.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // Keep the real selectAgentSessions — only the data hook is stubbed.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessions: () => ({ sessions: [], isLoading: false }),
}));

let currentSearch: Record<string, string | undefined> = {};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => {
    return ({
      search,
    }: {
      search: (prev: Record<string, string | undefined>) => Record<string, string | undefined>;
    }) => {
      currentSearch = { ...search(currentSearch) };
    };
  },
  useSearch: () => currentSearch,
  useRouter: () => ({ state: { location: { search: currentSearch } } }),
}));

vi.mock('@/layers/features/agent-settings', () => ({
  AgentDialog: () => null,
}));

// Mock AgentEmptyFilterState to make it easily assertable
vi.mock('../ui/AgentEmptyFilterState', () => ({
  AgentEmptyFilterState: ({
    onClearFilters,
  }: {
    onClearFilters: () => void;
    filterDescription?: string;
  }) => (
    <div data-testid="agent-empty-filter-state">
      <button onClick={onClearFilters}>Clear filters</button>
    </div>
  ),
}));

// Mock formatRelativeTime for deterministic output. Mock the source module so
// the shared barrel re-export picks it up without disrupting other utils.
vi.mock('@/layers/shared/lib/session-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib/session-utils')>();
  return { ...actual, formatRelativeTime: () => '5m ago' };
});

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
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
    }),
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
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
    taskCount: 0,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  currentSearch = {};
});

describe('AgentsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeleton when isLoading is true', () => {
    const { container } = render(<AgentsList agents={[]} isLoading={true} />, {
      wrapper: createWrapper(),
    });

    // Skeleton elements should be present
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a table row for each agent', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // Each agent name should appear in the table
    expect(screen.getByText('Agent A')).toBeInTheDocument();
    expect(screen.getByText('Agent B')).toBeInTheDocument();
    expect(screen.getByText('Agent C')).toBeInTheDocument();
  });

  it('does NOT group by namespace (flat table)', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // All agents are in a flat table — no namespace group headers
    expect(screen.getByText('Agent A')).toBeInTheDocument();
    expect(screen.getByText('Agent C')).toBeInTheDocument();
    // No namespace headers rendered as <h3>
    const h3s = document.querySelectorAll('h3');
    for (const h3 of h3s) {
      expect(h3.textContent).not.toBe('web');
      expect(h3.textContent).not.toBe('api');
    }
  });

  it('renders the composable FilterBar with search input', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByPlaceholderText('Filter agents...')).toBeInTheDocument();
  });

  it('renders result count', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('3 agents')).toBeInTheDocument();
  });

  it('shows empty state when search param filters out all agents', () => {
    // Pre-set the URL search state to simulate an active search filter
    currentSearch = { search: 'xyzzy-no-match' };

    render(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByTestId('agent-empty-filter-state')).toBeInTheDocument();
    expect(screen.queryByText('Agent A')).not.toBeInTheDocument();
  });

  it('shows empty state when status param filters out all agents', () => {
    // All agents are 'active'; filter by 'inactive' via URL
    currentSearch = { status: 'inactive' };

    render(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByTestId('agent-empty-filter-state')).toBeInTheDocument();
  });

  it('does not render AgentEmptyFilterState when the agents array is empty', () => {
    render(<AgentsList agents={[]} isLoading={false} />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('agent-empty-filter-state')).not.toBeInTheDocument();
  });

  it('clear filters via AgentEmptyFilterState restores the agent list', () => {
    // Start with an active filter that matches nothing
    currentSearch = { search: 'xyzzy-no-match' };

    const { rerender } = render(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByTestId('agent-empty-filter-state')).toBeInTheDocument();

    // Click clear — navigate mock updates currentSearch
    act(() => {
      screen.getByRole('button', { name: 'Clear filters' }).click();
    });

    // Re-render to pick up the cleared search state
    rerender(
      <AgentsList
        agents={multiNsAgents.map((a) => ({ ...a, healthStatus: 'active' as const }))}
        isLoading={false}
      />
    );

    expect(screen.queryByTestId('agent-empty-filter-state')).not.toBeInTheDocument();
    expect(screen.getByText('Agent A')).toBeInTheDocument();
  });

  it('renders status column with health indicators', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Active Agent', healthStatus: 'active' }),
          makeAgent({ id: '2', name: 'Stale Agent', healthStatus: 'stale' }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('shows "No agents registered." when data is empty', () => {
    render(<AgentsList agents={[]} isLoading={false} />, { wrapper: createWrapper() });

    expect(screen.getByText('No agents registered.')).toBeInTheDocument();
  });

  it('renders Chat action button with correct aria-label for each agent', () => {
    render(<AgentsList agents={[makeAgent({ id: '1', name: 'Alpha' })]} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByRole('button', { name: 'Chat with Alpha' })).toBeInTheDocument();
  });

  it('renders Manage action button with correct aria-label for each agent', () => {
    render(<AgentsList agents={[makeAgent({ id: '1', name: 'Alpha' })]} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByRole('button', { name: 'Manage Alpha' })).toBeInTheDocument();
  });

  it('renders Chat and Manage buttons for every agent row', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // Each of the 3 agents should have both action buttons
    expect(screen.getByRole('button', { name: 'Chat with Agent A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage Agent A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat with Agent B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage Agent B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat with Agent C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage Agent C' })).toBeInTheDocument();
  });
});
