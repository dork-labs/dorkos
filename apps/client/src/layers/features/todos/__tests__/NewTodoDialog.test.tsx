/**
 * @vitest-environment jsdom
 */
/**
 * The New to-do dialog (DOR-3088): Enter adds the to-do for the person, a picked date goes as the
 * end of that local day, and nothing is sent without a title.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { COMMITMENT_WHAT_MAX } from '@dorkos/shared/commitment-schemas';
import { NewTodoDialog, titleFromMessage, type TodoMessageSource } from '../index';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

function renderDialog(source?: TodoMessageSource) {
  const transport = createMockTransport();
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <NewTodoDialog open onOpenChange={onOpenChange} {...(source ? { source } : {})} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onOpenChange };
}

describe('NewTodoDialog', () => {
  it('adds a to-do for the person on Enter, and closes', async () => {
    const user = userEvent.setup();
    const { transport, onOpenChange } = renderDialog();
    await user.type(screen.getByLabelText('To-do'), '  Send the invoice  {Enter}');
    await waitFor(() =>
      expect(transport.createTodo).toHaveBeenCalledWith({
        what: 'Send the invoice',
        assignee: { kind: 'person', account: 'owner' },
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sends a picked date as the end of that day, with this computer’s offset', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();
    await user.type(screen.getByLabelText('To-do'), 'Send the invoice');
    fireEvent.change(screen.getByLabelText('Due (optional)'), {
      target: { value: '2026-11-05' },
    });
    await user.click(screen.getByRole('button', { name: 'Add to-do' }));
    await waitFor(() => expect(transport.createTodo).toHaveBeenCalledOnce());
    const body = vi.mocked(transport.createTodo).mock.calls[0]![0];
    expect(body.dueAt).toMatch(/^2026-11-05T23:59:59[+-]\d{2}:\d{2}$/);
    expect(new Date(body.dueAt!).getDate()).toBe(5);
  });

  it('sends nothing without a title', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();
    expect(screen.getByRole('button', { name: 'Add to-do' })).toBeDisabled();
    await user.type(screen.getByLabelText('To-do'), '   {Enter}');
    expect(transport.createTodo).not.toHaveBeenCalled();
  });

  it('starts from a message’s first line and names the message, so the server reads its author', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog({
      entryId: 'entry-7',
      text: '\n  Renew the domain  \nIt lapses Friday.',
    });
    expect(screen.getByRole('heading', { name: 'Make a to-do' })).toBeInTheDocument();
    expect(screen.getByLabelText('To-do')).toHaveValue('Renew the domain');
    await user.click(screen.getByRole('button', { name: 'Add to-do' }));
    await waitFor(() =>
      expect(transport.createTodo).toHaveBeenCalledWith({
        what: 'Renew the domain',
        assignee: { kind: 'person', account: 'owner' },
        sourceEntryId: 'entry-7',
      })
    );
  });
});

describe('titleFromMessage', () => {
  it('cuts a long first line to the longest title a to-do takes', () => {
    expect(titleFromMessage('x'.repeat(COMMITMENT_WHAT_MAX + 40))).toHaveLength(
      COMMITMENT_WHAT_MAX
    );
    expect(titleFromMessage('   \n\n')).toBe('');
  });
});
