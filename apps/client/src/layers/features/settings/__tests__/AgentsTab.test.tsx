/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

// Mock ResetDorkBotDialog to isolate AgentsTab
vi.mock('../ui/ResetDorkBotDialog', () => ({
  ResetDorkBotDialog: () => null,
}));

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

afterEach(cleanup);

// Mock Radix dialog portal to render inline
vi.mock('@radix-ui/react-dialog', async () => {
  const actual =
    await vi.importActual<typeof import('@radix-ui/react-dialog')>('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

import { AgentsTab } from '../ui/AgentsTab';

describe('AgentsTab', () => {
  it('shows default agent dropdown when agents exist', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({
        agents: [
          { id: '1', name: 'dorkbot', runtime: 'claude-code' },
          { id: '2', name: 'my-agent', runtime: 'claude-code' },
        ],
      }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Default agent')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-agent-select')).toBeInTheDocument();
  });

  it('does not show dropdown when no agents registered', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    // Wait for queries to settle, then verify no dropdown
    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalled();
    });
    expect(screen.queryByText('Default agent')).not.toBeInTheDocument();
  });

  it('always shows reset dorkbot personality card', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({
        agents: [{ id: '1', name: 'dorkbot', runtime: 'claude-code' }],
      }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByTestId('reset-dorkbot-card')).toBeInTheDocument();
    });
    expect(screen.getByText('Reset DorkBot Personality')).toBeInTheDocument();
  });

  it('shows reset card even when dorkbot is absent', async () => {
    const transport = createMockTransport({
      listMeshAgents: vi.fn().mockResolvedValue({
        agents: [{ id: '1', name: 'other-agent', runtime: 'claude-code' }],
      }),
      getConfig: vi.fn().mockResolvedValue({
        agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      }),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByTestId('reset-dorkbot-card')).toBeInTheDocument();
    });
  });
});
