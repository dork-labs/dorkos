/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentHubProvider } from '../model/agent-hub-context';
import type { AgentHubContextValue } from '../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks — stub sibling feature components to avoid pulling in their full
// dependency trees.  Each mock renders a marker element so the test can verify
// that the hub wrapper delegates correctly.
// ---------------------------------------------------------------------------

// agent-settings tabs (PersonalityTab, ChannelsTab, ToolsTab)
vi.mock('@/layers/features/agent-settings', () => ({
  PersonalityTab: (props: Record<string, unknown>) => (
    <div data-testid="personality-tab-inner" data-agent-id={(props.agent as AgentManifest).id}>
      PersonalityTabInner
    </div>
  ),
  ChannelsTab: (props: Record<string, unknown>) => (
    <div data-testid="channels-tab-inner" data-agent-id={(props.agent as AgentManifest).id}>
      ChannelsTabInner
    </div>
  ),
  ToolsTab: (props: Record<string, unknown>) => (
    <div
      data-testid="tools-tab-inner"
      data-agent-id={(props.agent as AgentManifest).id}
      data-project-path={props.projectPath as string}
    >
      ToolsTabInner
    </div>
  ),
}));

// session-list views (SessionsView, TasksView)
vi.mock('@/layers/features/session-list', () => ({
  SessionsView: (props: Record<string, unknown>) => (
    <div
      data-testid="sessions-view"
      data-active-session-id={props.activeSessionId as string | null}
    >
      SessionsView
    </div>
  ),
  TasksView: (props: Record<string, unknown>) => (
    <div data-testid="tasks-view" data-tool-status={props.toolStatus as string}>
      TasksView
    </div>
  ),
}));

// entity hooks used by OverviewTab and SessionsTab
vi.mock('@/layers/entities/session', () => ({
  useSessions: vi.fn(() => ({
    sessions: [
      {
        id: 'session-1',
        cwd: '/test/agent/path',
        updatedAt: '2026-01-15T10:00:00Z',
      },
      {
        id: 'session-2',
        cwd: '/other/path',
        updatedAt: '2026-01-14T10:00:00Z',
      },
    ],
    activeSessionId: 'session-1',
    setActiveSession: vi.fn(),
  })),
}));

// entity hook used by TasksTab
vi.mock('@/layers/entities/agent', () => ({
  useAgentToolStatus: vi.fn(() => ({
    tasks: 'enabled',
    relay: 'enabled',
    mesh: 'enabled',
    adapter: 'enabled',
  })),
}));

// groupSessionsByTime — passthrough to keep test assertions simple
vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<typeof import('@/layers/shared/lib')>('@/layers/shared/lib');
  return {
    ...actual,
    groupSessionsByTime: (sessions: unknown[]) =>
      sessions.length > 0 ? [{ label: 'Today', sessions }] : [],
  };
});

// ---------------------------------------------------------------------------
// Imports — after mocks so module resolution picks up stubs
// ---------------------------------------------------------------------------
import { OverviewTab } from '../ui/tabs/OverviewTab';
import { PersonalityTab } from '../ui/tabs/PersonalityTab';
import { ChannelsTab } from '../ui/tabs/ChannelsTab';
import { ToolsTab } from '../ui/tabs/ToolsTab';
import { SessionsTab } from '../ui/tabs/SessionsTab';
import { TasksTab } from '../ui/tabs/TasksTab';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockTransport = createMockTransport();

const mockAgent = {
  id: 'test-agent-id',
  name: 'test-agent',
  displayName: 'Test Agent',
  description: 'A test agent for unit testing',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00Z',
  registeredBy: 'test',
  traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
  color: '#6366f1',
  icon: '\ud83e\udd16',
} as unknown as AgentManifest;

function HubWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const contextValue: AgentHubContextValue = {
    agent: mockAgent,
    projectPath: '/test/agent/path',
    onUpdate: vi.fn(),
    onPersonalityUpdate: vi.fn(),
  };
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <AgentHubProvider value={contextValue}>{children}</AgentHubProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('OverviewTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders SessionsView with sessions filtered to the agent project path', () => {
    render(<OverviewTab />, { wrapper: HubWrapper });
    const view = screen.getByTestId('sessions-view');
    expect(view).toBeInTheDocument();
    expect(view).toHaveTextContent('SessionsView');
  });

  it('passes activeSessionId through to SessionsView', () => {
    render(<OverviewTab />, { wrapper: HubWrapper });
    const view = screen.getByTestId('sessions-view');
    expect(view).toHaveAttribute('data-active-session-id', 'session-1');
  });
});

describe('PersonalityTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the inner PersonalityTab from agent-settings', () => {
    render(<PersonalityTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('personality-tab-inner')).toBeInTheDocument();
  });

  it('passes agent from hub context to the inner component', () => {
    render(<PersonalityTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('personality-tab-inner')).toHaveAttribute(
      'data-agent-id',
      'test-agent-id'
    );
  });
});

describe('ChannelsTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the inner ChannelsTab from agent-settings', () => {
    render(<ChannelsTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('channels-tab-inner')).toBeInTheDocument();
  });

  it('passes agent from hub context to the inner component', () => {
    render(<ChannelsTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('channels-tab-inner')).toHaveAttribute(
      'data-agent-id',
      'test-agent-id'
    );
  });
});

describe('ToolsTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the inner ToolsTab from agent-settings', () => {
    render(<ToolsTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('tools-tab-inner')).toBeInTheDocument();
  });

  it('passes agent and projectPath from hub context to the inner component', () => {
    render(<ToolsTab />, { wrapper: HubWrapper });
    const inner = screen.getByTestId('tools-tab-inner');
    expect(inner).toHaveAttribute('data-agent-id', 'test-agent-id');
    expect(inner).toHaveAttribute('data-project-path', '/test/agent/path');
  });
});

describe('SessionsTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders SessionsView with sessions filtered to the agent project path', () => {
    render(<SessionsTab />, { wrapper: HubWrapper });
    const view = screen.getByTestId('sessions-view');
    expect(view).toBeInTheDocument();
    expect(view).toHaveTextContent('SessionsView');
  });

  it('passes activeSessionId through to SessionsView', () => {
    render(<SessionsTab />, { wrapper: HubWrapper });
    const view = screen.getByTestId('sessions-view');
    expect(view).toHaveAttribute('data-active-session-id', 'session-1');
  });
});

describe('TasksTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the TasksView from session-list', () => {
    render(<TasksTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('tasks-view')).toBeInTheDocument();
  });

  it('passes tool status resolved from the agent project path', () => {
    render(<TasksTab />, { wrapper: HubWrapper });
    expect(screen.getByTestId('tasks-view')).toHaveAttribute('data-tool-status', 'enabled');
  });
});
