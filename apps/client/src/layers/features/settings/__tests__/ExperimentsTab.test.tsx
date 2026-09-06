/**
 * @vitest-environment jsdom
 */
/**
 * The Experiments tab, driven through the real read/write path.
 *
 * `useConfig`/`useUpdateConfig` are NOT mocked here: they are the thing under
 * test as much as the markup is, because the whole design rests on the tab
 * holding no table of its own — it draws what the server sent and writes the path
 * back. A suite that stubbed both hooks would pass against a tab that had
 * hardcoded its two rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ExperimentsTab, buildNestedPatch } from '../ui/ExperimentsTab';

interface WireExperiment {
  key: string;
  title: string;
  description: string;
  costNote?: string;
  enabled: boolean;
  lockedByEnv: boolean;
  envOverride?: string;
}

const WARM: WireExperiment = {
  key: 'runtimes.claudeCode.persistentSession',
  title: 'Keep agents warm between messages',
  description: 'Your agent stays running between messages, so replies start about 4× faster.',
  costNote: 'Keeps up to about 1 GB of memory per warm agent.',
  enabled: false,
  lockedByEnv: false,
};

const A2A: WireExperiment = {
  key: 'a2a.enabled',
  title: 'Let outside agents reach yours',
  description: 'Agents on other systems can send work to the agents here.',
  enabled: false,
  lockedByEnv: false,
};

let updateConfig: Mock<(patch: Record<string, unknown>) => Promise<void>>;

/** Mount the tab over a transport reporting `experiments`. */
function renderTab(experiments: WireExperiment[] | undefined): void {
  updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', experiments }),
    updateConfig,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExperimentsTab />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('buildNestedPatch', () => {
  it('nests a dot-path into the body PATCH /api/config deep-merges', () => {
    expect(buildNestedPatch('runtimes.claudeCode.persistentSession', true)).toEqual({
      runtimes: { claudeCode: { persistentSession: true } },
    });
  });

  it('handles a single-hop path and carries the value through unchanged', () => {
    expect(buildNestedPatch('a2a.enabled', false)).toEqual({ a2a: { enabled: false } });
  });
});

describe('ExperimentsTab', () => {
  it('renders one switch per entry the server sent, with its prose', async () => {
    renderTab([WARM, A2A]);

    expect(await screen.findByRole('switch', { name: WARM.title })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: A2A.title })).toBeInTheDocument();
    // The cost rides along in the row's own description, so a person reads it
    // before flipping rather than after.
    expect(screen.getByText(new RegExp('1 GB'))).toBeInTheDocument();
  });

  it('writes the nested patch for the row that was flipped, and only that row', async () => {
    const user = userEvent.setup();
    renderTab([WARM, A2A]);

    await user.click(await screen.findByRole('switch', { name: A2A.title }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({ a2a: { enabled: true } });
  });

  it('writes the OFF position when the row is already on', async () => {
    const user = userEvent.setup();
    renderTab([{ ...WARM, enabled: true }, A2A]);

    await user.click(await screen.findByRole('switch', { name: WARM.title }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { persistentSession: false } },
    });
  });

  it('disables a row an environment variable decides, and names the variable', async () => {
    renderTab([
      WARM,
      { ...A2A, enabled: true, lockedByEnv: true, envOverride: 'DORKOS_A2A_ENABLED' },
    ]);

    const locked = await screen.findByRole('switch', { name: A2A.title });
    expect(locked).toBeDisabled();
    // The position shown is the variable's, and the row explains itself BY NAME —
    // a disabled switch that will not say what to unset is a dead end.
    expect(locked).toBeChecked();
    expect(
      screen.getByText(/Right now DORKOS_A2A_ENABLED on this machine decides it/)
    ).toBeInTheDocument();
    // The other row is untouched by its neighbour's lock.
    expect(screen.getByRole('switch', { name: WARM.title })).not.toBeDisabled();
  });

  it('never writes from a locked row', async () => {
    const user = userEvent.setup();
    renderTab([{ ...A2A, lockedByEnv: true, envOverride: 'DORKOS_A2A_ENABLED' }]);

    await user.click(await screen.findByRole('switch', { name: A2A.title }));

    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('says so plainly when there is nothing to try — the success state', async () => {
    renderTab([]);

    expect(await screen.findByTestId('experiments-empty')).toHaveTextContent(
      /Nothing’s cooking right now/
    );
    // "Show dev tools" is not one of the server-sent experiments — it is the
    // one switch this tab draws itself — so it survives an empty list.
    expect(screen.queryAllByRole('switch')).toHaveLength(1);
    expect(screen.getByRole('switch', { name: 'Show dev tools' })).toBeInTheDocument();
  });

  it('does not claim the list is empty while the config is still loading', () => {
    // A getConfig that never resolves pins the loading state open: the empty
    // message asserts "nothing is waiting on you", which is unknown mid-fetch.
    updateConfig = vi.fn().mockResolvedValue(undefined);
    const transport: Transport = createMockTransport({
      getConfig: vi.fn().mockReturnValue(new Promise(() => {})),
      updateConfig,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ExperimentsTab />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(screen.queryByTestId('experiments-empty')).not.toBeInTheDocument();
    // Pure client state, not server-derived — DOR-1758 follow-up (I4): the
    // one production path to the developer panel must not wait on a config
    // read that may never resolve.
    expect(screen.getByRole('switch', { name: 'Show dev tools' })).toBeInTheDocument();
  });

  it('shows the empty state on a server too old to report the block at all', async () => {
    renderTab(undefined);

    expect(await screen.findByTestId('experiments-empty')).toBeInTheDocument();
  });

  it('keeps the dev-tools switch reachable when the server refuses to answer', async () => {
    // The exact failure scenario the Server tab has (I4, DOR-1758 follow-up):
    // mid-restart, or refusing outright, is precisely when someone reaches for
    // the developer panel — and the one production path to it must not be
    // gated behind the same config read that just failed.
    updateConfig = vi.fn().mockResolvedValue(undefined);
    const transport: Transport = createMockTransport({
      getConfig: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      updateConfig,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ExperimentsTab />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByRole('switch', { name: 'Show dev tools' })).toBeInTheDocument();
  });

  it('always states the deal, whether or not there is anything listed', async () => {
    renderTab([WARM]);

    expect(await screen.findByText(/These are off until you turn them on\./)).toBeInTheDocument();
  });
});
