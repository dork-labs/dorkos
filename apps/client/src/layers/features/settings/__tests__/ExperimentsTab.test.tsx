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
import { describe, it, expect, vi, beforeEach, afterEach, type Mock, onTestFinished } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport, BrowserProductionTransport } from '@dorkos/shared/transport';
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
function renderTab(
  experiments: WireExperiment[] | undefined,
  browserProduction?: BrowserProductionTransport
) {
  updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ version: '1.0.0', experiments }),
    updateConfig,
    browserProduction,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExperimentsTab />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient };
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
      screen.getByText(/DORKOS_A2A_ENABLED on this computer controls this switch/)
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
      /No experiments right now/
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

    expect(await screen.findByText(/These start off\./)).toBeInTheDocument();
  });
});

const BROWSER: WireExperiment = {
  key: 'browser.enabled',
  title: 'Shared browser',
  description: 'Open a browser that you and your agents can use together.',
  enabled: false,
  lockedByEnv: false,
};
function browserPort(
  setBrowserRuntimeEnabled: BrowserProductionTransport['setBrowserRuntimeEnabled']
): BrowserProductionTransport {
  return {
    createBrowserProfile: vi.fn(),
    setBrowserRuntimeEnabled,
    readBrowserRuntimeStatus: vi.fn(),
    openBrowserRuntime: vi.fn(),
    getBrowserBindings: vi.fn(),
    takeBrowserControl: vi.fn(),
  };
}
// Semantic port doubles with real query/mutation hooks, not native/auth/startup acceptance.
describe('Shared browser experiment operation', () => {
  it('uses explicit verified activation instead of generic config PATCH', async () => {
    const set = vi.fn<BrowserProductionTransport['setBrowserRuntimeEnabled']>().mockResolvedValue({
      state: 'ready',
      enabled: true,
      workspaces: [],
    });
    renderTab([BROWSER], browserPort(set));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Shared browser' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith(true, expect.any(AbortSignal)));
    expect(updateConfig).not.toHaveBeenCalled();
  });
  it('retains the original off operation and disables duplicate writes until cleanup actually settles', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let returned = false;
    const set = vi.fn<BrowserProductionTransport['setBrowserRuntimeEnabled']>(async () => {
      await held;
      returned = true;
      return { state: 'disabled', enabled: false };
    });
    onTestFinished(async () => {
      release();
      await Promise.allSettled(set.mock.results.map((row) => row.value));
    });
    renderTab([{ ...BROWSER, enabled: true }], browserPort(set));
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Shared browser' });
    await user.click(toggle);
    await user.click(toggle);
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(toggle).toBeDisabled();
    expect(toggle).toBeChecked();
    expect(returned).toBe(false);
    expect(updateConfig).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(returned).toBe(true));
  });
  it('keeps the stored position and exposes refusal instead of falling back to generic PATCH', async () => {
    const set = vi
      .fn<BrowserProductionTransport['setBrowserRuntimeEnabled']>()
      .mockRejectedValue(undefined);
    renderTab([BROWSER], browserPort(set));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Shared browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Shared browser could not be changed.'
    );
    expect(screen.getByRole('switch', { name: 'Shared browser' })).not.toBeChecked();
    expect(updateConfig).not.toHaveBeenCalled();
  });
  it('refuses activation when the server provides no semantic capability', async () => {
    renderTab([BROWSER]);
    expect(await screen.findByRole('switch', { name: 'Shared browser' })).toBeDisabled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe('Chrome user agent experiment choice', () => {
  const CHROME: WireExperiment = {
    key: 'browser.chromeUserAgent',
    title: 'Use Chrome user agent',
    description: 'Use Chrome identity.',
    enabled: false,
    lockedByEnv: false,
  };
  it('uses the retained runtime owner operation while Shared browser is Off', async () => {
    const user = userEvent.setup();
    const set = vi
      .fn<BrowserProductionTransport['setBrowserRuntimeEnabled']>()
      .mockResolvedValue({ state: 'disabled', enabled: false });
    const port = browserPort(set);
    vi.mocked(port.readBrowserRuntimeStatus).mockResolvedValue({
      state: 'disabled',
      enabled: false,
    });
    renderTab([BROWSER, CHROME], port);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Use Chrome user agent' })).not.toBeDisabled()
    );
    await user.click(await screen.findByRole('switch', { name: 'Use Chrome user agent' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(false, expect.any(AbortSignal), { chromeUserAgent: true })
    );
  });
  it('cannot change identity while Shared browser is enabled', async () => {
    renderTab([{ ...BROWSER, enabled: true }, CHROME]);
    expect(await screen.findByRole('switch', { name: 'Use Chrome user agent' })).toBeDisabled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
  it('keeps Chrome selection disabled until the original held runtime status confirms Off', async () => {
    let release!: (
      value: Awaited<ReturnType<BrowserProductionTransport['readBrowserRuntimeStatus']>>
    ) => void;
    const held = new Promise<
      Awaited<ReturnType<BrowserProductionTransport['readBrowserRuntimeStatus']>>
    >((resolve) => {
      release = resolve;
    });
    const port = browserPort(vi.fn().mockResolvedValue({ state: 'disabled', enabled: false }));
    vi.mocked(port.readBrowserRuntimeStatus).mockReturnValue(held);
    onTestFinished(() => release({ state: 'disabled', enabled: false }));
    renderTab([BROWSER, CHROME], port);
    const choice = await screen.findByRole('switch', { name: 'Use Chrome user agent' });
    expect(choice).toBeDisabled();
    await userEvent.click(choice);
    expect(port.setBrowserRuntimeEnabled).not.toHaveBeenCalled();
    release({ state: 'disabled', enabled: false });
    await waitFor(() => expect(choice).not.toBeDisabled());
  });
  it('keeps Chrome selection disabled when original runtime status fails', async () => {
    const port = browserPort(vi.fn());
    vi.mocked(port.readBrowserRuntimeStatus).mockRejectedValue(undefined);
    renderTab([BROWSER, CHROME], port);
    const choice = await screen.findByRole('switch', { name: 'Use Chrome user agent' });
    await waitFor(() => expect(port.readBrowserRuntimeStatus).toHaveBeenCalledOnce());
    expect(choice).toBeDisabled();
    await userEvent.click(choice);
    expect(port.setBrowserRuntimeEnabled).not.toHaveBeenCalled();
  });
  it.each([
    { state: 'ready' as const, enabled: true as const, workspaces: [] },
    { state: 'unavailable' as const, enabled: false, cause: 'nativeUnavailable' as const },
  ])(
    'refuses Chrome selection when runtime status is $state despite stored Off',
    async (status) => {
      const port = browserPort(vi.fn());
      vi.mocked(port.readBrowserRuntimeStatus).mockResolvedValue(status);
      renderTab([BROWSER, CHROME], port);
      const choice = await screen.findByRole('switch', { name: 'Use Chrome user agent' });
      await waitFor(() => expect(port.readBrowserRuntimeStatus).toHaveBeenCalledOnce());
      expect(choice).toBeDisabled();
      await userEvent.click(choice);
      expect(port.setBrowserRuntimeEnabled).not.toHaveBeenCalled();
    }
  );
  it('disables selection while a fresh status observation is held over cached Off', async () => {
    let release!: (
      value: Awaited<ReturnType<BrowserProductionTransport['readBrowserRuntimeStatus']>>
    ) => void;
    const held = new Promise<
      Awaited<ReturnType<BrowserProductionTransport['readBrowserRuntimeStatus']>>
    >((resolve) => {
      release = resolve;
    });
    const port = browserPort(vi.fn());
    vi.mocked(port.readBrowserRuntimeStatus)
      .mockResolvedValueOnce({ state: 'disabled', enabled: false })
      .mockReturnValueOnce(held);
    onTestFinished(() => release({ state: 'disabled', enabled: false }));
    const { queryClient } = renderTab([BROWSER, CHROME], port);
    const choice = await screen.findByRole('switch', { name: 'Use Chrome user agent' });
    await waitFor(() => expect(choice).not.toBeDisabled());
    const refresh = queryClient.invalidateQueries({ queryKey: ['browser', 'runtime-status'] });
    onTestFinished(async () => {
      release({ state: 'disabled', enabled: false });
      await refresh;
    });
    await waitFor(() => expect(choice).toBeDisabled());
    await userEvent.click(choice);
    expect(port.setBrowserRuntimeEnabled).not.toHaveBeenCalled();
    release({ state: 'disabled', enabled: false });
    await refresh;
    await waitFor(() => expect(choice).not.toBeDisabled());
  });
});
