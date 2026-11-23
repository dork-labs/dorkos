/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig, TaskRun } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { TaskAccountLine } from '../TaskAccountLine';
import { runAccountMoveLine } from '../../../lib/run-account-move';

afterEach(cleanup);

function renderLine(task: Parameters<typeof TaskAccountLine>[0]['task'], transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TaskAccountLine task={task} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const config = {
  claudeCode: {
    accounts: [{ id: 'claude5', path: '/accounts/claude5', label: 'Claude5', isAccountRoot: true }],
  },
} as unknown as ServerConfig;

describe('TaskAccountLine', () => {
  it('says nothing for a task that follows its agent’s account', () => {
    const { container } = renderLine(
      { id: 't1', account: null },
      createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) })
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the account and says another takes the run when it is out', async () => {
    renderLine(
      { id: 't1', account: 'claude5' },
      createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) })
    );
    expect(await screen.findByText('Runs on Claude5')).toBeInTheDocument();
    expect(screen.getByText(/Another account takes the run/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'This account only' })).not.toBeChecked();
  });

  it('pins the task to its account', async () => {
    const updateTask = vi.fn().mockResolvedValue({});
    renderLine(
      { id: 't1', account: 'claude5' },
      createMockTransport({ getConfig: vi.fn().mockResolvedValue(config), updateTask })
    );
    fireEvent.click(screen.getByRole('switch', { name: 'This account only' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('t1', { accountPinned: true }));
  });

  it('says a pinned task’s run won’t start when its account is out', () => {
    renderLine(
      { id: 't1', account: 'claude5', accountPinned: true },
      createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) })
    );
    expect(screen.getByText(/Runs only here/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'This account only' })).toBeChecked();
  });
});

describe('runAccountMoveLine', () => {
  const run = (accountMove?: TaskRun['accountMove']) => ({ accountMove }) as TaskRun;

  it('says which account a moved run used, and why', () => {
    expect(
      runAccountMoveLine(
        run({
          from: { id: 'claude4', label: 'Claude4' },
          to: { id: 'claude5', label: null },
          reason: 'limited',
        })
      )
    ).toBe('Ran on claude5: Claude4 was out of usage.');
    expect(
      runAccountMoveLine(
        run({
          from: { id: 'c5', label: 'Claude5' },
          to: { id: 'c3', label: 'Claude3' },
          reason: 'signed-out',
        })
      )
    ).toBe('Ran on Claude3: Claude5 was signed out.');
  });

  it('says nothing for a run on its own account', () => {
    expect(runAccountMoveLine(run())).toBeNull();
  });
});
