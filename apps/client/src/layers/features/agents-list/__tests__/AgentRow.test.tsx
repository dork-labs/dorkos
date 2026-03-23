/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUnregisterMutate = vi.fn();
vi.mock('@/layers/entities/mesh', () => ({
  useUnregisterAgent: () => ({ mutate: mockUnregisterMutate }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/layers/entities/session', () => ({
  useSessions: () => ({ sessions: [], isLoading: false }),
}));

// Mock AgentDialog to isolate AgentRow
vi.mock('@/layers/features/agent-settings', () => ({
  AgentDialog: () => null,
}));

// Mock SessionLaunchPopover to isolate AgentRow
vi.mock('../ui/SessionLaunchPopover', () => ({
  SessionLaunchPopover: ({ projectPath }: { projectPath: string }) => (
    <button data-testid="session-launch-popover" data-project-path={projectPath}>
      Start Session
    </button>
  ),
}));

// Mock relativeTime to return a deterministic value in tests
vi.mock('@/layers/features/mesh/lib/relative-time', () => ({
  relativeTime: (iso: string | null) => (iso ? '5m ago' : 'Never'),
}));

// Mock UnregisterAgentDialog to capture open state and agent props
const mockUnregisterDialogOnOpenChange = vi.fn();
vi.mock('../ui/UnregisterAgentDialog', () => ({
  UnregisterAgentDialog: ({
    agentName,
    agentId,
    open,
    onOpenChange,
  }: {
    agentName: string;
    agentId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    mockUnregisterDialogOnOpenChange.mockImplementation(onOpenChange);
    if (!open) return null;
    return (
      <div data-testid="unregister-dialog" data-agent-id={agentId} data-agent-name={agentName}>
        <button onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
    );
  },
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

const agentFixture = {
  id: 'agent-1',
  name: 'Frontend Agent',
  description: 'Handles UI tasks',
  runtime: 'claude-code' as const,
  capabilities: ['code', 'review', 'test', 'deploy', 'docs'],
  behavior: { responseMode: 'always' as const, escalationThreshold: undefined },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  namespace: 'web',
  registeredAt: new Date().toISOString(),
  registeredBy: 'test-user',
  personaEnabled: true,
  enabledToolGroups: {},
};

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { AgentRow } from '../ui/AgentRow';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders collapsed row with name, runtime badge, and truncated path', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/home/user/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    // Radix Collapsible may render content in multiple DOM nodes
    expect(screen.getAllByText('Frontend Agent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('claude-code').length).toBeGreaterThanOrEqual(1);
    // Truncated path: last 2 segments
    expect(screen.getAllByText('projects/frontend').length).toBeGreaterThanOrEqual(1);
  });

  it('shows health status dot with correct color class for active', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    const dot = container.querySelector('.bg-emerald-500');
    expect(dot).toBeInTheDocument();
  });

  it('shows health status dot with correct color class for inactive', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="inactive"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    const dot = container.querySelector('.bg-amber-500');
    expect(dot).toBeInTheDocument();
  });

  it('expands on click revealing full description', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    // Click the cursor-pointer card header to toggle expansion
    const trigger = container.querySelector('.cursor-pointer') as HTMLElement;
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);

    // After expansion, description should be visible
    expect(screen.getByText('Handles UI tasks')).toBeInTheDocument();
  });

  it('does not show capability badges in collapsed state', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    // Capabilities are only shown in expanded state — none visible when collapsed
    expect(screen.queryByText('code')).not.toBeInTheDocument();
    expect(screen.queryByText('+2 more')).not.toBeInTheDocument();
  });

  it('shows all capability badges in expanded state', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    const trigger = container.querySelector('.cursor-pointer') as HTMLElement;
    fireEvent.click(trigger);

    // All 5 capabilities should be visible after expansion
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
    expect(screen.getByText('deploy')).toBeInTheDocument();
  });

  it('shows session count badge when sessions exist', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={3}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('3 active')).toBeInTheDocument();
  });

  it('does not show session count badge when sessionCount is 0', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    // "N active" badge should not appear when sessionCount is 0
    expect(screen.queryByText(/\d+ active/)).not.toBeInTheDocument();
  });

  it('opens UnregisterAgentDialog when Unregister button is clicked', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    // Expand the row first
    const trigger = container.querySelector('.cursor-pointer') as HTMLElement;
    fireEvent.click(trigger);

    // Click Unregister button
    const unregisterBtn = screen.getByRole('button', { name: /unregister/i });
    fireEvent.click(unregisterBtn);

    // UnregisterAgentDialog should now be open with correct agent props
    const dialog = screen.getByTestId('unregister-dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-agent-id', 'agent-1');
    expect(dialog).toHaveAttribute('data-agent-name', 'Frontend Agent');
  });

  it('displays relative time from relativeTime()', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive="2026-03-23T10:00:00.000Z"
      />,
      { wrapper: createWrapper() }
    );

    // Mock returns '5m ago' for any non-null ISO string
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  it('displays "Never" when lastActive is null', () => {
    render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('adds animate-health-pulse class to dot when healthStatus is active', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="active"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    const dot = container.querySelector('.bg-emerald-500');
    expect(dot).toHaveClass('animate-health-pulse');
  });

  it('does not add animate-health-pulse class when healthStatus is inactive', () => {
    const { container } = render(
      <AgentRow
        agent={agentFixture}
        projectPath="/projects/frontend"
        sessionCount={0}
        healthStatus="inactive"
        lastActive={null}
      />,
      { wrapper: createWrapper() }
    );

    const dot = container.querySelector('.bg-amber-500');
    expect(dot).not.toHaveClass('animate-health-pulse');
  });
});
