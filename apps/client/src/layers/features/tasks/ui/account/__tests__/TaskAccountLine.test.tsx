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

function renderLine(
  task: Parameters<typeof TaskAccountLine>[0]['task'],
  transport: Transport,
  agent?: Parameters<typeof TaskAccountLine>[0]['agent']
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TaskAccountLine task={task} agent={agent} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const config = {
  claudeCode: {
    accounts: [{ id: 'claude5', path: '/accounts/claude5', label: 'Claude5', isAccountRoot: true }],
  },
} as unknown as ServerConfig;

const base = {
  id: 't1',
  account: 'claude5',
  runtime: null,
  sticky: false,
  lastRunAt: null,
} as Parameters<typeof TaskAccountLine>[0]['task'];

describe('TaskAccountLine', () => {
  const withConfig = (extra: Partial<Transport> = {}) =>
    createMockTransport({ getConfig: vi.fn().mockResolvedValue(config), ...extra });

  it('says nothing for a task on another runtime', () => {
    const { container } = renderLine({ ...base, runtime: 'codex' }, withConfig());
    expect(container).toBeEmptyDOMElement();
  });

  it('names the account and says another takes the run when it is out', async () => {
    renderLine(base, withConfig());
    expect(await screen.findByText('Runs on Claude5')).toBeInTheDocument();
    expect(screen.getByText(/Another account takes the run/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'This account only' })).not.toBeChecked();
  });

  it('shows the agent’s account, with the switch, for a task that follows it', async () => {
    renderLine({ ...base, account: null }, withConfig(), {
      account: 'claude5',
      runtime: 'claude-code',
    });
    expect(await screen.findByText('Runs on Claude5 (its agent’s)')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'This account only' })).toBeInTheDocument();
  });

  it('shows the default for a task that names no account and whose agent names none', () => {
    renderLine({ ...base, account: null }, withConfig());
    expect(screen.getByText(/\(the default\)$/)).toBeInTheDocument();
  });

  it('pins the task to its account', async () => {
    const updateTask = vi.fn().mockResolvedValue({});
    renderLine(base, withConfig({ updateTask }));
    fireEvent.click(screen.getByRole('switch', { name: 'This account only' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('t1', { accountPinned: true }));
  });

  it('says a pinned task’s run won’t start when its account is out', () => {
    renderLine({ ...base, accountPinned: true }, withConfig());
    expect(screen.getByText(/Runs only here/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'This account only' })).toBeChecked();
  });

  it('names DorkOS credits in words, with no move rule and no switch', () => {
    renderLine({ ...base, account: 'dorkos-credits' }, withConfig());
    expect(screen.getByText('Runs on DorkOS credits')).toBeInTheDocument();
    expect(screen.queryByText(/dorkos-credits/)).toBeNull();
    expect(screen.queryByText(/Another account/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('names the main sign-in by its name, never its `default` id', async () => {
    const main = {
      claudeCode: {
        ...(config as { claudeCode: object }).claudeCode,
        resolvedAccount: '/home/u/.claude',
      },
    } as unknown as ServerConfig;
    renderLine(
      { ...base, account: 'default' },
      createMockTransport({ getConfig: vi.fn().mockResolvedValue(main) })
    );
    expect(await screen.findByText(/^Runs on (?!default)/)).toBeInTheDocument();
    expect(screen.queryByText('Runs on default')).toBeNull();
  });

  it('says a remembered chat that already ran stays on its account', () => {
    renderLine({ ...base, sticky: true, lastRunAt: '2026-11-23T10:00:00.000Z' }, withConfig());
    expect(screen.getByText(/remembered chat stays on this account/)).toBeInTheDocument();
    expect(screen.queryByText(/Another account/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
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
