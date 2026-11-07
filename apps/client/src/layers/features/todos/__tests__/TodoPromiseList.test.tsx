/**
 * @vitest-environment jsdom
 */
/**
 * The to-dos list (spec `heartbeats` §12): empty, open first with overdue
 * marked, closed folded, and a person's two actions plus adding one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TodoPromiseList } from '../index';

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }));

afterEach(() => {
  cleanup();
  toastSuccess.mockReset();
});

/** A to-do with sensible defaults. */
function todoPromise(overrides: Partial<TodoPromise>): TodoPromise {
  return {
    id: 'c1',
    agentId: 'agent-ana',
    to: null,
    what: 'Ship the fix',
    dueAt: null,
    state: 'open',
    overdue: false,
    sourceSessionId: null,
    sourceRoomEntryId: null,
    createdAt: '2026-10-10T09:00:00.000Z',
    closedAt: null,
    note: null,
    ...overrides,
  };
}

function renderList(
  todoPromises: TodoPromise[],
  props: Parameters<typeof TodoPromiseList>[0] = {}
) {
  const transport = createMockTransport();
  vi.mocked(transport.listTodoPromises).mockResolvedValue({ todoPromises });
  vi.mocked(transport.updateTodoPromise).mockImplementation(async (id, body) => ({
    ...todoPromises.find((c) => c.id === id)!,
    state: body.state,
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TodoPromiseList {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('TodoPromiseList', () => {
  it('says so when there are no promises', async () => {
    renderList([]);
    expect(await screen.findByText('No to-dos yet.')).toBeInTheDocument();
  });

  it('reads one agent’s list when given an agent', async () => {
    const transport = renderList([], { agentId: 'agent-ana' });
    await screen.findByText('No to-dos yet.');
    expect(transport.listTodoPromises).toHaveBeenCalledWith({ agentId: 'agent-ana' });
  });

  it('marks an overdue promise and names its agent and recipient on the team list', async () => {
    renderList(
      [
        todoPromise({
          id: 'late',
          what: 'Reply to Acme',
          to: 'external:Acme',
          overdue: true,
          dueAt: '2026-10-09T09:00:00.000Z',
        }),
        todoPromise({ id: 'fine', what: 'Tidy the docs' }),
      ],
      { nameOf: (id) => (id === 'agent-ana' ? 'Ana' : undefined) }
    );
    const open = await screen.findByRole('list', { name: 'Open to-dos' });
    const rows = within(open).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Ana · To Acme')).toBeInTheDocument();
    // A past date never reads like a future one.
    expect(within(rows[0]!).getByText(/^Overdue · /)).toBeInTheDocument();
    expect(within(rows[1]!).queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  it('folds kept, missed and dropped promises under a closed toggle', async () => {
    const user = userEvent.setup();
    renderList([
      todoPromise({ id: 'open', what: 'Still to do' }),
      todoPromise({ id: 'kept', what: 'Already done', state: 'kept' }),
      todoPromise({ id: 'missed', what: 'Never happened', state: 'missed' }),
    ]);
    await screen.findByText('Still to do');
    expect(screen.queryByText('Already done')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Closed (2)' }));
    const closed = screen.getByRole('list', { name: 'Closed to-dos' });
    expect(within(closed).getByText('Already done')).toBeInTheDocument();
    expect(within(closed).getByText('Missed')).toBeInTheDocument();
    // A closed promise offers nothing to do.
    expect(within(closed).queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks a promise kept, and drops another', async () => {
    const user = userEvent.setup();
    const transport = renderList([
      todoPromise({ id: 'a', what: 'Ship the fix' }),
      todoPromise({ id: 'b', what: 'Write the post' }),
    ]);
    await user.click(await screen.findByRole('button', { name: 'Mark kept: Ship the fix' }));
    await waitFor(() =>
      expect(transport.updateTodoPromise).toHaveBeenCalledWith('a', { state: 'kept' })
    );
    await user.click(screen.getByRole('button', { name: 'Drop: Write the post' }));
    await waitFor(() =>
      expect(transport.updateTodoPromise).toHaveBeenCalledWith('b', { state: 'dropped' })
    );
  });

  it('adds a promise for the agent on one agent’s list', async () => {
    const user = userEvent.setup();
    const transport = renderList([], { agentId: 'agent-ana', canAdd: true });
    await user.click(await screen.findByRole('button', { name: 'Add to-do' }));
    const addButton = screen.getByRole('button', { name: 'Add to-do' });
    expect(addButton).toBeDisabled();
    await user.type(screen.getByLabelText('What was promised'), 'Send Acme the quote');
    await user.click(addButton);
    await waitFor(() =>
      expect(transport.createTodoPromise).toHaveBeenCalledWith('agent-ana', {
        what: 'Send Acme the quote',
      })
    );
  });

  it('never offers to add on the team-wide list', async () => {
    renderList([], { canAdd: true });
    await screen.findByText('No to-dos yet.');
    expect(screen.queryByRole('button', { name: 'Add to-do' })).not.toBeInTheDocument();
  });

  it('shows someone else’s agent’s list as facts, with no controls', async () => {
    renderList([todoPromise({ id: 'a', what: 'Ship the fix' })], {
      agentId: 'agent-ana',
      canAdd: true,
      readOnly: true,
    });
    await screen.findByText('Ship the fix');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Undo after Mark kept, and Undo reopens it', async () => {
    const user = userEvent.setup();
    const transport = renderList([todoPromise({ id: 'a', what: 'Ship the fix' })]);
    await user.click(await screen.findByRole('button', { name: 'Mark kept: Ship the fix' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [message, options] = toastSuccess.mock.calls[0]!;
    expect(message).toBe('Marked kept');
    options.action.onClick();
    await waitFor(() =>
      // `from` makes a late Undo refuse rather than revert someone else's change.
      expect(transport.updateTodoPromise).toHaveBeenLastCalledWith('a', {
        state: 'open',
        from: 'kept',
      })
    );
  });

  it('says the time has passed when the server refuses the date', async () => {
    const user = userEvent.setup();
    const transport = renderList([], { agentId: 'agent-ana', canAdd: true });
    vi.mocked(transport.createTodoPromise).mockRejectedValue(
      Object.assign(new Error('That due date has passed.'), { code: 'PAST_DUE' })
    );
    await user.click(await screen.findByRole('button', { name: 'Add to-do' }));
    await user.type(screen.getByLabelText('What was promised'), 'Reply');
    await user.click(screen.getByRole('button', { name: 'Add to-do' }));
    expect(await screen.findByText('That time has passed.')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t save the to-do. Try again.')).not.toBeInTheDocument();
  });

  it('skips the controls on a row the person cannot change', async () => {
    renderList([todoPromise({ id: 'a', what: 'Mine' }), todoPromise({ id: 'b', what: 'Theirs' })], {
      canChange: (c) => c.id === 'a',
    });
    await screen.findByText('Mine');
    expect(screen.getByRole('button', { name: 'Mark kept: Mine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark kept: Theirs' })).not.toBeInTheDocument();
  });

  it('refuses a due time that has passed in the add form', async () => {
    const user = userEvent.setup();
    const transport = renderList([], { agentId: 'agent-ana', canAdd: true });
    await user.click(await screen.findByRole('button', { name: 'Add to-do' }));
    await user.type(screen.getByLabelText('What was promised'), 'Reply');
    fireEvent.change(screen.getByLabelText('Due (optional)'), {
      target: { value: '2020-01-01T09:00' },
    });
    expect(screen.getByText('That time has passed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to-do' })).toBeDisabled();
    expect(transport.createTodoPromise).not.toHaveBeenCalled();
  });
});
