/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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
  supportedTransports: readonly (typeof TRANSPORTS)[number][]
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
});
