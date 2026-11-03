/**
 * @vitest-environment jsdom
 */
/**
 * The to-do list (DOR-3088): it opens on the person's own view, the chips change what it asks,
 * a row completes in place with a moment to undo, done ones fold behind a count, and an empty
 * view says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTodo, createMockTransport } from '@dorkos/test-utils';
import type { Todo } from '@dorkos/shared/todo-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { TodoList } from '../index';

afterEach(cleanup);

function renderList(
  todos: Todo[],
  options: { doneCount?: number; onNewTodo?: () => void; transport?: Transport } = {}
) {
  const transport = options.transport ?? createMockTransport();
  if (!options.transport) {
    vi.mocked(transport.listTodos).mockResolvedValue({
      todos,
      doneCount: options.doneCount ?? 0,
      badge: 0,
    });
  }
  vi.mocked(transport.updateTodo).mockImplementation(async (id, body) => ({
    ...(todos.find((t) => t.id === id) ?? createMockTodo({ id })),
    ...(body.state ? { state: body.state } : {}),
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <TodoList onNewTodo={options.onNewTodo ?? (() => {})} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('TodoList', () => {
  it('opens on the person’s own to-dos', async () => {
    const transport = renderList([createMockTodo({ what: 'Send the invoice' })]);
    expect(await screen.findByText('Send the invoice')).toBeInTheDocument();
    expect(transport.listTodos).toHaveBeenCalledWith({ view: 'mine' });
    expect(screen.getByRole('button', { name: 'Assigned to me' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('asks for another view when its chip is pressed', async () => {
    const user = userEvent.setup();
    const transport = renderList([createMockTodo()]);
    await screen.findByText('Send the invoice');
    await user.click(screen.getByRole('button', { name: 'Assigned by me' }));
    await waitFor(() => expect(transport.listTodos).toHaveBeenCalledWith({ view: 'by-me' }));
    await user.click(screen.getByRole('button', { name: 'Everyone' }));
    await waitFor(() => expect(transport.listTodos).toHaveBeenCalledWith({ view: 'everyone' }));
  });

  it('completes a to-do in place and puts it back with Undo', async () => {
    const user = userEvent.setup();
    const todo = createMockTodo({ id: 'todo-a', what: 'Send the invoice' });
    const transport = renderList([todo]);
    await user.click(await screen.findByRole('checkbox', { name: 'Send the invoice' }));

    await waitFor(() =>
      expect(transport.updateTodo).toHaveBeenCalledWith('todo-a', { state: 'kept' })
    );
    const row = screen.getByText('Send the invoice').closest('li')!;
    expect(within(row).getByText('Done')).toBeInTheDocument();

    await user.click(await within(row).findByRole('button', { name: 'Undo' }));
    expect(transport.updateTodo).toHaveBeenLastCalledWith('todo-a', {
      state: 'open',
      from: 'kept',
    });
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Send the invoice' })).toHaveAttribute(
        'aria-checked',
        'false'
      )
    );
  });

  it('offers Undo only once the server has saved the completion', async () => {
    const user = userEvent.setup();
    const todo = createMockTodo({ id: 'todo-a', what: 'Send the invoice' });
    const transport = renderList([todo]);
    let finish: (value: Todo) => void = () => {};
    vi.mocked(transport.updateTodo).mockImplementationOnce(
      () => new Promise<Todo>((resolve) => (finish = resolve))
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Send the invoice' }));
    const row = screen.getByText('Send the invoice').closest('li')!;
    expect(within(row).getByText('Done')).toBeInTheDocument();
    // Undo now could reach the server before the completion and lose.
    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
    finish({ ...todo, state: 'kept' });
    expect(await within(row).findByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('drops a held row when the view changes', async () => {
    const user = userEvent.setup();
    const todo = createMockTodo({ id: 'todo-a', what: 'Send the invoice' });
    const transport = createMockTransport();
    vi.mocked(transport.listTodos).mockImplementation(async (query) =>
      query?.view === 'everyone'
        ? { todos: [], doneCount: 0, badge: 0 }
        : { todos: [todo], doneCount: 0, badge: 0 }
    );
    renderList([todo], { transport });
    await user.click(await screen.findByRole('checkbox', { name: 'Send the invoice' }));
    await user.click(screen.getByRole('button', { name: 'Everyone' }));
    await waitFor(() => expect(transport.listTodos).toHaveBeenCalledWith({ view: 'everyone' }));
    expect(await screen.findByText('No to-dos here.')).toBeInTheDocument();
    expect(screen.queryByText('Send the invoice')).toBeNull();
  });

  it('lets a completed to-do leave the open list after a moment', async () => {
    const user = userEvent.setup();
    const todo = createMockTodo({ id: 'todo-a', what: 'Send the invoice' });
    const transport = createMockTransport();
    vi.mocked(transport.listTodos)
      .mockResolvedValueOnce({ todos: [todo], doneCount: 0, badge: 0 })
      .mockResolvedValue({ todos: [], doneCount: 1, badge: 0 });
    renderList([todo], { transport });
    await user.click(await screen.findByRole('checkbox', { name: 'Send the invoice' }));

    // Still on screen once the list has been read again without it.
    await waitFor(() => expect(transport.listTodos).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Send the invoice')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Send the invoice')).toBeNull(), {
      timeout: 3_000,
    });
  });

  it('shows done ones behind their count', async () => {
    const user = userEvent.setup();
    const transport = renderList([createMockTodo()], { doneCount: 3 });
    await user.click(await screen.findByRole('button', { name: 'Show done (3)' }));
    await waitFor(() =>
      expect(transport.listTodos).toHaveBeenCalledWith({ view: 'mine', showDone: true })
    );
    expect(screen.queryByRole('button', { name: /Show done/ })).toBeNull();
  });

  it('offers a new to-do when nothing is assigned to the person', async () => {
    const user = userEvent.setup();
    const onNewTodo = vi.fn();
    renderList([], { onNewTodo });
    expect(await screen.findByText('Nothing assigned to you.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New to-do' }));
    expect(onNewTodo).toHaveBeenCalledOnce();
  });

  it('says so plainly when another view is empty', async () => {
    const user = userEvent.setup();
    renderList([]);
    await screen.findByText('Nothing assigned to you.');
    await user.click(screen.getByRole('button', { name: 'For agents' }));
    expect(await screen.findByText('No to-dos here.')).toBeInTheDocument();
  });

  it('marks a to-do that runs at a guest’s limits, and words kept from the source', async () => {
    renderList([
      createMockTodo({
        assignee: { kind: 'agent', agentId: 'agent-ana' },
        assignedBy: { kind: 'outsider', id: 'telegram:ana' },
        strangerBound: true,
        titleFromSource: true,
        sourceAuthor: 'Ana',
      }),
    ]);
    expect(await screen.findByText('Limited')).toBeInTheDocument();
    expect(screen.getByText('from a guest')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it("leaves the limit off the person's own to-do, where no turn runs", async () => {
    renderList([createMockTodo({ what: 'Call the bank', strangerBound: true })]);
    expect(await screen.findByText('Call the bank')).toBeInTheDocument();
    expect(screen.queryByText('Limited')).not.toBeInTheDocument();
  });

  it('reads a declined to-do as declined, with its reason', async () => {
    renderList([createMockTodo({ state: 'dropped', note: 'No booking access' })]);
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(screen.getByText('No booking access')).toBeInTheDocument();
  });

  it('moves a to-do down with ⌥↓ in My order, rewriting only its rank', async () => {
    const user = userEvent.setup();
    const transport = renderList([
      createMockTodo({ id: 'a', what: 'First', rank: 'f' }),
      createMockTodo({ id: 'b', what: 'Second', rank: 'm' }),
      createMockTodo({ id: 'c', what: 'Third', rank: 't' }),
    ]);
    await screen.findByText('First');
    await user.click(screen.getByRole('button', { name: 'Filter and sort' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'My order' }));
    await waitFor(() =>
      expect(transport.listTodos).toHaveBeenCalledWith({ view: 'mine', sort: 'rank' })
    );
    const grip = await screen.findByRole('button', { name: 'Move First' });
    grip.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(transport.updateTodo).toHaveBeenCalledOnce());
    const [id, body] = vi.mocked(transport.updateTodo).mock.calls[0]!;
    expect(id).toBe('a');
    expect(body.rank! > 'm' && body.rank! < 't').toBe(true);
  });

  it('offers no grip outside My order', async () => {
    renderList([
      createMockTodo({ id: 'a', what: 'First' }),
      createMockTodo({ id: 'b', what: 'Second' }),
    ]);
    await screen.findByText('First');
    expect(screen.queryByRole('button', { name: 'Move First' })).toBeNull();
  });
});
