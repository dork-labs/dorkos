/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useAgentHubStore } from '../model/agent-hub-store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: vi.fn(),
  useUpdateAgent: vi.fn(() => ({ mutate: vi.fn() })),
  resolveAgentVisual: vi.fn(() => ({ color: '#6366f1', emoji: '\ud83e\udd16' })),
  AgentIdentity: ({ name }: { name: string }) => <span data-testid="agent-identity">{name}</span>,
  AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="agent-avatar">{emoji}</span>,
}));

// Deep-link hooks call TanStack Router internals — stub them out so tests
// don't need a full RouterProvider wrapper.
vi.mock('../model/use-agent-hub-deep-link', () => ({
  useAgentHubDeepLink: vi.fn(),
  useAgentDialogRedirect: vi.fn(),
}));

// Hero uses useRouterState for the segmented control's visibleWhen predicate.
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/session',
}));

import { useCurrentAgent } from '@/layers/entities/agent';
import { AgentHub } from '../ui/AgentHub';

const mockTransport = createMockTransport();

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentHubStore.setState({ agentPath: null, activeTab: 'sessions' });
    useAppStore.setState({ selectedCwd: null });
  });

  it('renders NoAgentSelected when no agent path is available', () => {
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByText('No agent selected')).toBeInTheDocument();
  });

  it('renders AgentNotFound when agent data is null for a valid path', () => {
    useAppStore.setState({ selectedCwd: '/some/path' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: null,
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByText('Agent not found')).toBeInTheDocument();
  });

  it('renders hub shell with hero, tab bar, and content when agent is loaded', () => {
    useAppStore.setState({ selectedCwd: '/test/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: {
        id: 'test-id',
        name: 'Test Agent',
        displayName: 'Test Agent',
        slug: 'test-agent',
        color: '#6366f1',
        emoji: '\ud83e\udd16',
        traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByTestId('agent-name')).toHaveTextContent('Test Agent');
    expect(screen.getByRole('tablist', { name: 'Agent hub tabs' })).toBeInTheDocument();
  });

  it('uses hubStore agentPath over selectedCwd when set', () => {
    useAppStore.setState({ selectedCwd: '/default/agent' });
    useAgentHubStore.setState({ agentPath: '/specific/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: {
        id: 'specific-id',
        name: 'Specific',
        displayName: 'Specific',
        traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(useCurrentAgent).toHaveBeenCalledWith('/specific/agent');
  });
});
