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
}));

// Deep-link hooks call TanStack Router internals — stub them out so tests
// don't need a full RouterProvider wrapper.
vi.mock('../model/use-agent-hub-deep-link', () => ({
  useAgentHubDeepLink: vi.fn(),
  useAgentDialogRedirect: vi.fn(),
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
    useAgentHubStore.setState({ agentPath: null, activeTab: 'overview' });
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

  it('renders hub shell with nav and content when agent is loaded', () => {
    useAppStore.setState({ selectedCwd: '/test/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: {
        id: 'test-id',
        name: 'Test Agent',
        slug: 'test-agent',
        color: '#6366f1',
        emoji: '\ud83e\udd16',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByText('Test Agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent hub navigation')).toBeInTheDocument();
  });

  it('uses hubStore agentPath over selectedCwd when set', () => {
    useAppStore.setState({ selectedCwd: '/default/agent' });
    useAgentHubStore.setState({ agentPath: '/specific/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: { name: 'Specific' },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(useCurrentAgent).toHaveBeenCalledWith('/specific/agent');
  });
});
