/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { AddMcpServerForm, TRANSPORTS } from '../ui/AddMcpServerForm';

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — browser APIs jsdom does not implement, and without them the
// listbox never opens, so the closed trigger is all a test can see.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function renderForm(
  transport: Transport,
  supportedTransports: readonly (typeof TRANSPORTS)[number][],
  onAdded: (server: { name: string; transport: (typeof TRANSPORTS)[number] }) => void = () => {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(
    <AddMcpServerForm
      agentId="01HZ0000000000000000000001"
      agentLabel="Test Agent"
      supportedTransports={supportedTransports}
      onAdded={onAdded}
    />,
    { wrapper }
  );
}

/** Open the form, then open the transport menu and read back every option offered. */
function offeredTransports(): string[] {
  fireEvent.click(screen.getByRole('button', { name: /add server/i }));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

describe('AddMcpServerForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('hides sse for a Codex-supported transport set (no SSE transport, DOR-892)', () => {
    const transport = createMockTransport();
    renderForm(transport, ['stdio', 'http']);

    expect(offeredTransports()).toEqual(['stdio', 'http']);
  });

  it('shows sse for a runtime that supports the full transport set', () => {
    const transport = createMockTransport();
    renderForm(transport, TRANSPORTS);

    expect(offeredTransports()).toEqual(['stdio', 'http', 'sse']);
  });

  it('reports what it added, with the fields still filled in (DOR-985)', async () => {
    const onAdded = vi.fn();
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({ status: 'ok', servers: [] }),
    });
    renderForm(transport, TRANSPORTS, onAdded);

    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'granola' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'http' }));
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://mcp.granola.ai/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Reporting after `reset()` would hand back an empty name — the form's own
    // fields are cleared by then, which is why the callback reads the input it
    // submitted rather than current state.
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith({ name: 'granola', transport: 'http' })
    );
  });

  it('reports nothing while the add is still waiting on approval', async () => {
    const onAdded = vi.fn();
    const transport = createMockTransport({
      addAgentMcpServer: vi.fn().mockResolvedValue({
        status: 'approval_required',
        approval: { status: 'approval_required', approvalId: 'a', approvalToken: 't' },
      }),
    });
    renderForm(transport, TRANSPORTS, onAdded);

    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'granola' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Nothing was written yet, so nothing to follow up on.
    await waitFor(() =>
      expect(screen.getByText(/Confirm this server for Test Agent/i)).toBeInTheDocument()
    );
    expect(onAdded).not.toHaveBeenCalled();
  });
});
