/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { useAgentHubStore } from '../model/agent-hub-store';

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
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: vi.fn(),
  useUpdateAgent: vi.fn(() => ({ mutate: vi.fn() })),
  resolveAgentVisual: vi.fn(() => ({ color: '#6366f1', emoji: '\ud83e\udd16' })),
  useNebulaAlpha: () => ({
    heroGlow: '18',
    heroGlowOuter: '08',
    pillBgStart: '12',
    pillBgEnd: '08',
    pillBorder: '40',
    pillGlow: '33',
  }),
  PresetPill: ({ emoji, name }: { emoji: string; name: string }) => (
    <button data-testid="preset-pill">
      {emoji} {name}
    </button>
  ),
  AgentIdentity: ({ name }: { name: string }) => <span data-testid="agent-identity">{name}</span>,
  AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="agent-avatar">{emoji}</span>,
}));

// Deep-link hooks call TanStack Router internals — stub them out so tests
// don't need a full RouterProvider wrapper.
vi.mock('../model/use-agent-hub-deep-link', () => ({
  useAgentHubDeepLink: vi.fn(),
  useAgentDialogRedirect: vi.fn(),
}));

// AgentHub reads the pathname to decide whether the selectedCwd fallback is
// honest (only on /session). Mutable so tests can exercise off-session routes.
// Named `mock*` so vitest's mock hoisting permits the reference.
let mockPathname = '/session';
vi.mock('@tanstack/react-router', () => ({
  useRouterState: (opts?: { select?: (s: { location: { pathname: string } }) => unknown }) =>
    opts?.select ? opts.select({ location: { pathname: mockPathname } }) : mockPathname,
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
    mockPathname = '/session';
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
        traits: DEFAULT_TRAITS,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByTestId('agent-name')).toHaveTextContent('Test Agent');
    expect(screen.getByRole('tablist', { name: 'Agent hub tabs' })).toBeInTheDocument();
  });

  it('degrades to AgentNotFound (no throw) when an explicitly-opened agent is later deleted', () => {
    // The tab-level lifecycle now heals: useReconcileExplicitAgentPath clears
    // explicitAgentPath when the opened agent no longer resolves, so off /session
    // the Agent Profile tab is removed rather than lingering. The AgentHub
    // COMPONENT itself must still degrade gracefully if rendered on a dead path
    // (before the reconcile fires, or on /session where the tab is always
    // visible) — this test renders it directly to lock that non-crashing
    // AgentNotFound fallback.
    mockPathname = '/'; // rendered directly here, bypassing the tab visibility gate
    useAgentHubStore.setState({ agentPath: '/opened/then-deleted' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: null, // agent manifest gone
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    expect(() => render(<AgentHub />, { wrapper: TestWrapper })).not.toThrow();
    expect(screen.getByText('Agent not found')).toBeInTheDocument();
  });

  it('does not resolve the ambient cwd off /session without an explicit selection', () => {
    // Selection honesty (fix 2): off /session, selectedCwd is the server's
    // ambient startup directory, not a user pick. With no explicit hub selection
    // the hub must NOT profile it — it shows "No agent selected" instead.
    mockPathname = '/';
    useAppStore.setState({ selectedCwd: '/ambient/agent' });
    useAgentHubStore.setState({ agentPath: null });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(screen.getByText('No agent selected')).toBeInTheDocument();
    // The ambient cwd was never used to resolve an agent.
    expect(useCurrentAgent).toHaveBeenCalledWith(null);
  });

  it('resolves an explicitly-opened agent off /session', () => {
    // With an explicit hub selection the hub profiles it regardless of route.
    mockPathname = '/';
    useAppStore.setState({ selectedCwd: '/ambient/agent' });
    useAgentHubStore.setState({ agentPath: '/explicit/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: {
        id: 'explicit-id',
        name: 'Explicit',
        displayName: 'Explicit',
        traits: DEFAULT_TRAITS,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(useCurrentAgent).toHaveBeenCalledWith('/explicit/agent');
  });

  it('uses hubStore agentPath over selectedCwd when set', () => {
    useAppStore.setState({ selectedCwd: '/default/agent' });
    useAgentHubStore.setState({ agentPath: '/specific/agent' });
    vi.mocked(useCurrentAgent).mockReturnValue({
      data: {
        id: 'specific-id',
        name: 'Specific',
        displayName: 'Specific',
        traits: DEFAULT_TRAITS,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useCurrentAgent>);
    render(<AgentHub />, { wrapper: TestWrapper });
    expect(useCurrentAgent).toHaveBeenCalledWith('/specific/agent');
  });
});
