/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentsTab } from '../ui/AgentsTab';
import { ResetDorkBotDialog } from '../ui/ResetDorkBotDialog';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => {
  const successFn = vi.fn();
  const errorFn = vi.fn();
  return {
    toast: Object.assign(vi.fn(), { success: successFn, error: errorFn }),
  };
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
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function createWrapper(transport: Transport) {
  const queryClient = createTestQueryClient();
  return {
    queryClient,
    Wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

function mockTransportWithAgents(agents: Array<{ name: string; id: string }>) {
  const transport = createMockTransport();
  vi.mocked(transport.listMeshAgents).mockResolvedValue({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: '',
      runtime: 'claude-code',
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
      personaEnabled: true,
      traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
      conventions: { soul: true, nope: true, dorkosKnowledge: true },
      enabledToolGroups: {},
    })) as never,
  });
  return transport;
}

// ---------------------------------------------------------------------------
// Tests: AgentsTab — Reset DorkBot card
// ---------------------------------------------------------------------------

describe('AgentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('shows Reset DorkBot Personality card always', async () => {
    const transport = mockTransportWithAgents([{ name: 'dorkbot', id: '1' }]);
    const { Wrapper } = createWrapper(transport);

    render(<AgentsTab />, { wrapper: Wrapper });

    expect(await screen.findByTestId('reset-dorkbot-card')).toBeInTheDocument();
    expect(screen.getByText('Reset DorkBot Personality')).toBeInTheDocument();
  });

  it('shows Reset DorkBot Personality card even when dorkbot is absent', async () => {
    const transport = mockTransportWithAgents([{ name: 'other-agent', id: '1' }]);
    const { Wrapper } = createWrapper(transport);

    render(<AgentsTab />, { wrapper: Wrapper });

    expect(await screen.findByTestId('reset-dorkbot-card')).toBeInTheDocument();
  });

  it('clicking Reset DorkBot Personality opens dialog when dorkbot exists', async () => {
    const user = userEvent.setup();
    const transport = mockTransportWithAgents([{ name: 'dorkbot', id: 'db-1' }]);
    const { Wrapper } = createWrapper(transport);

    render(<AgentsTab />, { wrapper: Wrapper });

    const button = await screen.findByText('Reset DorkBot Personality');
    await user.click(button);

    expect(await screen.findByTestId('reset-dorkbot-dialog')).toBeInTheDocument();
    expect(
      screen.getByText("Reset DorkBot's personality traits to their default values.")
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: ResetDorkBotDialog
// ---------------------------------------------------------------------------

describe('ResetDorkBotDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('renders confirmation dialog with title and description', () => {
    const transport = createMockTransport();
    const { Wrapper } = createWrapper(transport);

    render(<ResetDorkBotDialog open={true} onOpenChange={vi.fn()} dorkbotId="db-1" />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText('Reset DorkBot Personality')).toBeInTheDocument();
    expect(
      screen.getByText("Reset DorkBot's personality traits to their default values.")
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls transport.updateMeshAgent with default traits on Reset', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.updateMeshAgent).mockResolvedValue({
      id: 'db-1',
      name: 'dorkbot',
    } as never);
    const onOpenChange = vi.fn();

    const { queryClient, Wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(<ResetDorkBotDialog open={true} onOpenChange={onOpenChange} dorkbotId="db-1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(transport.updateMeshAgent).toHaveBeenCalledWith('db-1', {
        traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
      });
    });

    // Should show success toast
    const { toast } = await import('sonner');
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('DorkBot personality reset to defaults');
    });

    // Should close dialog
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // Should invalidate agent queries
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['agents'] }));
    });
  });

  it('shows error toast on failed reset and keeps dialog open', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.updateMeshAgent).mockRejectedValue(new Error('Agent not found'));
    const onOpenChange = vi.fn();

    const { Wrapper } = createWrapper(transport);

    render(<ResetDorkBotDialog open={true} onOpenChange={onOpenChange} dorkbotId="db-1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Reset' }));

    const { toast } = await import('sonner');
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Agent not found');
    });

    // Dialog should stay open (onOpenChange not called with false)
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('closes dialog via Cancel button', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const onOpenChange = vi.fn();

    const { Wrapper } = createWrapper(transport);

    render(<ResetDorkBotDialog open={true} onOpenChange={onOpenChange} dorkbotId="db-1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows Resetting... text while mutation is pending', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();

    // Never-resolving promise to keep mutation in pending state
    vi.mocked(transport.updateMeshAgent).mockReturnValue(new Promise(() => {}));

    const { Wrapper } = createWrapper(transport);

    render(<ResetDorkBotDialog open={true} onOpenChange={vi.fn()} dorkbotId="db-1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(screen.getByText('Resetting...')).toBeInTheDocument();
    });
  });
});
