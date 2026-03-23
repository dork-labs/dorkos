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

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { UnregisterAgentDialog } from '../ui/UnregisterAgentDialog';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('UnregisterAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders agent name in dialog title', () => {
    render(
      <UnregisterAgentDialog
        agentName="Frontend Agent"
        agentId="agent-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() }
    );

    expect(screen.getByText('Unregister Frontend Agent?')).toBeInTheDocument();
  });

  it('renders re-discovery description', () => {
    render(
      <UnregisterAgentDialog
        agentName="Backend Agent"
        agentId="agent-2"
        open={true}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() }
    );

    expect(
      screen.getByText(
        'This will remove the agent from the mesh registry. The agent can be re-discovered by scanning its project directory.'
      )
    ).toBeInTheDocument();
  });

  it('calls unregister mutation with agent ID on confirm', () => {
    render(
      <UnregisterAgentDialog
        agentName="Frontend Agent"
        agentId="agent-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() }
    );

    fireEvent.click(screen.getByRole('button', { name: /unregister/i }));

    expect(mockUnregisterMutate).toHaveBeenCalledWith('agent-1');
  });

  it('calls onOpenChange when cancel button is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <UnregisterAgentDialog
        agentName="Frontend Agent"
        agentId="agent-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: createWrapper() }
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm button has destructive styling', () => {
    render(
      <UnregisterAgentDialog
        agentName="Frontend Agent"
        agentId="agent-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
      { wrapper: createWrapper() }
    );

    const confirmBtn = screen.getByRole('button', { name: /unregister/i });
    expect(confirmBtn).toHaveClass('bg-destructive');
    expect(confirmBtn).toHaveClass('text-destructive-foreground');
  });
});
