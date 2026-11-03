/**
 * @vitest-environment jsdom
 */
/**
 * A to-do's card (DOR-3088, Security's Must 3 and G3): drawn from the to-do the server returns,
 * as plain text; a to-do the reader can't see reads as unavailable; "Show work" opens the chat its
 * turn ran in, unless that's the chat already open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTodo, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TodoCard } from '../index';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

function renderCard(answer: (id: string) => Promise<unknown>, props: { sessionId?: string } = {}) {
  const transport = createMockTransport();
  vi.mocked(transport.getTodo).mockImplementation(answer as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TodoCard todoId="todo-1" {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('TodoCard', () => {
  it('draws the to-do the server returns, its words as plain text', async () => {
    const transport = renderCard(async () => ({
      ...createMockTodo({
        what: '**Renew** <b>the</b> domain',
        state: 'kept',
        note: 'Done Friday',
      }),
      workSessionId: null,
    }));
    expect(await screen.findByText('**Renew** <b>the</b> domain')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Done Friday')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="todo-card"] b')).toBeNull();
    expect(transport.getTodo).toHaveBeenCalledWith('todo-1');
  });

  it("says only that it's unavailable when the reader can't see the to-do", async () => {
    renderCard(async () => {
      throw Object.assign(new Error('No to-do has that id.'), { status: 404 });
    });
    expect(await screen.findByText('This to-do is unavailable.')).toBeInTheDocument();
  });

  it('opens the chat its turn ran in, and offers nothing when that chat is already open', async () => {
    renderCard(async () => ({ ...createMockTodo(), workSessionId: 'session-work' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show work' }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ session: 'session-work' }) })
    );
    cleanup();
    renderCard(async () => ({ ...createMockTodo(), workSessionId: 'session-dm' }), {
      sessionId: 'session-dm',
    });
    await screen.findByText('Send the invoice');
    expect(screen.queryByRole('button', { name: 'Show work' })).toBeNull();
  });
});
