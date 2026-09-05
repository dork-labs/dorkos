/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import type { AttentionState } from '@/layers/entities/session';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks — URL search state is simulated via a mutable record.
// ---------------------------------------------------------------------------

/**
 * Fleet-wide chat state per project path. Set per test; anything absent reads as
 * 'fresh' (no chats), the same default the component applies.
 */
let chatStates: Record<string, AttentionState> = {};

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useAgentAttentionMap: (paths: string[]) =>
    Object.fromEntries(paths.map((path) => [path, chatStates[path] ?? 'fresh'])),
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

// Mock AgentEmptyFilterState to make it easily assertable. `AgentRosterFilterEmpty`
// keeps its real copy: the words are the assertion, since that state's whole job
// is telling you WHICH filters emptied the table.
vi.mock('../ui/AgentEmptyFilterState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/AgentEmptyFilterState')>()),
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
    workspace: { mode: 'home' },
    id: overrides.id,
    name: overrides.name ?? `Agent ${overrides.id}`,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    namespace: overrides.namespace,
    // Registered a month ago, so silence means something. Tests that care about
    // the onboarding grace override this.
    registeredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    registeredBy: 'user',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
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

/** A last-seen timestamp, so no fixture accidentally reads as never-active. */
const SEEN_AT = '2026-07-25T10:00:00.000Z';

/** Group header rows rendered by the DataTable, in document order. */
const groupHeaders = () =>
  Array.from(document.querySelectorAll('[data-slot="data-table-group-header"]')).map(
    (el) => el.textContent
  );

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
  chatStates = {};
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

  it('does NOT group by namespace', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // Grouping is by attention state, never by namespace.
    expect(screen.getByText('Agent A')).toBeInTheDocument();
    expect(screen.getByText('Agent C')).toBeInTheDocument();
    expect(screen.queryByText('web')).not.toBeInTheDocument();
    expect(screen.queryByText('api')).not.toBeInTheDocument();
  });

  it('groups rows by attention state, most urgent group first', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Idle One', healthStatus: 'inactive', lastSeenAt: SEEN_AT }),
          makeAgent({ id: '2', name: 'Busy One', healthStatus: 'active', lastSeenAt: SEEN_AT }),
          makeAgent({
            id: '3',
            name: 'Gone One',
            healthStatus: 'unreachable',
            lastSeenAt: SEEN_AT,
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual(['Needs you1', 'Working1', 'Quiet1']);

    // Row order follows the groups.
    const rowText = screen
      .getAllByRole('row')
      .map((row) => row.textContent ?? '')
      .join('|');
    expect(rowText.indexOf('Gone One')).toBeLessThan(rowText.indexOf('Busy One'));
    expect(rowText.indexOf('Busy One')).toBeLessThan(rowText.indexOf('Idle One'));
  });

  it('populates "Working" for several agents at once, across different folders', () => {
    // The regression this pins. Chat state used to be counted from
    // `useSessions()`, which lists only the SELECTED working directory, so at
    // most one row in the fleet could ever reach Working and the rule was dead
    // for every other agent. Neither of these two folders is "the" selected one.
    chatStates = { '/b': 'active', '/c': 'active' };

    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Quiet One', healthStatus: 'inactive', lastSeenAt: SEEN_AT }),
          makeAgent({
            id: '2',
            name: 'Chatting B',
            projectPath: '/b',
            healthStatus: 'inactive',
            lastSeenAt: SEEN_AT,
          }),
          makeAgent({
            id: '3',
            name: 'Chatting C',
            projectPath: '/c',
            healthStatus: 'inactive',
            lastSeenAt: SEEN_AT,
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual(['Working2', 'Quiet1']);
  });

  it('never tells you a chat is open, because it cannot know that', () => {
    chatStates = { '/1': 'active' };

    render(
      <AgentsList
        agents={[makeAgent({ id: '1', name: 'Chatty', lastSeenAt: SEEN_AT })]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(document.body.textContent).not.toMatch(/session/i);
  });

  it('puts an agent whose chat is blocked in "Needs you" and says so', () => {
    chatStates = { '/1': 'needs-attention' };

    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Blocked', healthStatus: 'inactive', lastSeenAt: SEEN_AT }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual(['Needs you1']);
    expect(screen.getByText('A chat needs you')).toBeInTheDocument();
  });

  it('flags a long-registered agent that never reports while schedules keep coming due', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({
            id: '1',
            name: 'Silent Scheduler',
            healthStatus: 'stale',
            lastSeenAt: null,
            taskCount: 3,
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual(['Needs you1']);
  });

  it('leaves a just-registered agent quiet even with schedules attached', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({
            id: '1',
            name: 'Fresh DorkBot',
            healthStatus: 'stale',
            lastSeenAt: null,
            taskCount: 3,
            registeredAt: new Date().toISOString(),
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual(['Quiet1']);
  });

  it('flattens the groups when the user picks a field sort', () => {
    currentSearch = { sort: 'name:asc' };

    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Idle One', healthStatus: 'inactive', lastSeenAt: SEEN_AT }),
          makeAgent({
            id: '2',
            name: 'Gone One',
            healthStatus: 'unreachable',
            lastSeenAt: SEEN_AT,
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(groupHeaders()).toEqual([]);
    expect(screen.getByText('Gone One')).toBeInTheDocument();
    expect(screen.getByText('Idle One')).toBeInTheDocument();
  });

  it('labels the default order "Attention" in the sort menu', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(document.querySelector('[data-slot="filter-bar-sort"]')?.textContent).toContain(
      'Attention'
    );
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

  it('says what an agent last did, with the time underneath', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({
            id: '1',
            name: 'Active Agent',
            healthStatus: 'active',
            lastSeenAt: SEEN_AT,
            lastSeenEvent: 'response_complete',
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('Finished a reply')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    // Never the raw event name.
    expect(screen.queryByText('response_complete')).not.toBeInTheDocument();
  });

  it('shows a never-active agent as unused, not "Stale"/"Never"', () => {
    render(
      <AgentsList
        // A brand-new agent: server health is stale, last-seen is null.
        agents={[makeAgent({ id: '1', name: 'DorkBot', healthStatus: 'stale', lastSeenAt: null })]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('shows the runtime and project under the agent name', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({
            id: '1',
            name: 'Alpha',
            runtime: 'codex',
            projectPath: '/home/kai/blintz/app',
          }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('blintz/app')).toBeInTheDocument();
    expect(screen.getByText('· Codex')).toBeInTheDocument();
  });

  it('surfaces scheduled tasks, and stays silent when there are none', () => {
    render(
      <AgentsList
        agents={[
          makeAgent({ id: '1', name: 'Busy', lastSeenAt: SEEN_AT, taskCount: 7 }),
          makeAgent({ id: '2', name: 'Solo', lastSeenAt: SEEN_AT, taskCount: 1 }),
          makeAgent({ id: '3', name: 'None', lastSeenAt: SEEN_AT, taskCount: 0 }),
        ]}
        isLoading={false}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('7 schedules')).toBeInTheDocument();
    expect(screen.getByText('1 schedule')).toBeInTheDocument();
    // Exactly one row says nothing is scheduled. Scoped away from the Managed
    // by column, which draws the same dash for an agent nobody owns.
    const scheduledDashes = screen
      .getAllByText('—')
      .filter((el) => el.getAttribute('data-slot') !== 'agent-managed-by');
    expect(scheduledDashes).toHaveLength(1);
  });

  it('shows "No agents registered." when data is empty', () => {
    render(<AgentsList agents={[]} isLoading={false} />, { wrapper: createWrapper() });

    expect(screen.getByText('No agents registered.')).toBeInTheDocument();
  });

  // The row action lands on `/session` with the agent's directory. "Chat with"
  // named the other surface — a DM — so a person who wanted one and pressed
  // this got the other (spec `sidebar-simplification` §D2). Re-seed the old
  // word and the second assertion goes red.
  it('names the session its row action opens, and never calls it a chat', () => {
    render(<AgentsList agents={[makeAgent({ id: '1', name: 'Alpha' })]} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByRole('button', { name: 'Open session with Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Chat with/ })).not.toBeInTheDocument();
  });

  it('renders the View profile action button with correct aria-label for each agent', () => {
    render(<AgentsList agents={[makeAgent({ id: '1', name: 'Alpha' })]} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByRole('button', { name: 'Open Alpha’s profile' })).toBeInTheDocument();
  });

  it('renders Open session and View profile buttons for every agent row', () => {
    render(<AgentsList agents={multiNsAgents} isLoading={false} />, {
      wrapper: createWrapper(),
    });

    // Each of the 3 agents should have both action buttons
    expect(screen.getByRole('button', { name: 'Open session with Agent A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Agent A’s profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session with Agent B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Agent B’s profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session with Agent C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Agent C’s profile' })).toBeInTheDocument();
  });

  // The Team page's chips, group toggle and search box all narrow this table
  // too. They used to narrow nothing: `?kind=people` listed every agent while
  // the URL claimed people-only. `narrowAgentsByRoster` is unit-tested on its
  // own; this proves the prop actually reaches it.
  describe('the Team roster filters', () => {
    it('shows no agents when the roster is narrowed to people', () => {
      render(
        <AgentsList
          agents={multiNsAgents}
          isLoading={false}
          rosterFilters={{ kind: 'people', group: 'none' }}
        />,
        { wrapper: createWrapper() }
      );

      expect(
        screen.queryByRole('button', { name: 'Open session with Agent A' })
      ).not.toBeInTheDocument();
      expect(screen.getByText(/This table lists agents/)).toBeInTheDocument();
    });

    it('leaves the fleet alone when no roster filter is driving it', () => {
      render(<AgentsList agents={multiNsAgents} isLoading={false} />, { wrapper: createWrapper() });

      expect(screen.getByRole('button', { name: 'Open session with Agent A' })).toBeInTheDocument();
      expect(screen.queryByText(/This table lists agents/)).not.toBeInTheDocument();
    });
  });
});
