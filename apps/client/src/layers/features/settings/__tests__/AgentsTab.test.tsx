/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

beforeAll(() => {
  // Radix Select uses scrollIntoView internally — mock it to prevent jsdom errors.
  Element.prototype.scrollIntoView = vi.fn();

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

afterEach(() => {
  cleanup();
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

    await waitFor(() => {
      expect(transport.listMeshAgents).toHaveBeenCalled();
    });
    expect(screen.queryByText('Default agent')).not.toBeInTheDocument();
  });

  it('lists all registered agents as selectable options', async () => {
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
      expect(screen.getByTestId('default-agent-select')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: 'dorkbot' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'my-agent' })).toBeInTheDocument();
  });

  it('sets the default agent via the transport when a new selection is made', async () => {
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
      setDefaultAgent: vi.fn().mockResolvedValue(undefined),
    });

    render(<AgentsTab />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByTestId('default-agent-select')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'my-agent' }));

    await waitFor(() => {
      expect(transport.setDefaultAgent).toHaveBeenCalledWith('my-agent');
    });
  });
});
