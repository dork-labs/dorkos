// @vitest-environment jsdom
/**
 * The Remote Access dialog over the shared model, mounted TOGETHER.
 *
 * The subject here is the DIALOG's own derivation — which view it paints for a
 * given state, and what its two field errors do across a close and reopen. What
 * remote access itself does (starting, stopping, the two 409s, the status
 * toasts) is the shared model's business and is driven in
 * `entities/tunnel/__tests__/remote-access.test.tsx`; this file exists to prove
 * the dialog is wired to it rather than to a private copy.
 *
 * The bug it was written for lives in a gap unit tests leave: the sync effect
 * ran AFTER the action's setter and undid it, so every assertion on a spy
 * passed while the dialog showed the opposite. Only the real hooks, wired to
 * each other, can see it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { resetRemoteAccessStore, type TunnelReport } from '@/layers/entities/tunnel';
import { useTunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const baseTunnel = {
  enabled: false,
  connected: false,
  isRunning: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
} as unknown as TunnelReport;

/**
 * Mount the real machine and the real actions over one mock transport, with a
 * handle for moving what the SERVER reports independently of what the person
 * does — the two inputs whose collision is the whole subject of this file.
 */
function setup(initial: Partial<TunnelReport> = {}) {
  let served: TunnelReport = { ...baseTunnel, ...initial };
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const { result, rerender } = renderHook(
    // `open` defaults to false — the latency probe is not under test and would
    // put a real `fetch` at an ngrok URL from jsdom. It is a prop rather than a
    // constant because this hook is mounted for the life of the app, so opening
    // and closing the dialog is the ONLY lifecycle event it ever sees.
    ({ open }: { open: boolean }) => {
      const machine = useTunnelMachine({ open });
      return { machine, actions: useTunnelActions({ machine }) };
    },
    {
      initialProps: { open: false },
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );

  /** Close the dialog and open it again, without unmounting anything. */
  const reopenDialog = async () => {
    await act(async () => {
      rerender({ open: true });
    });
    await act(async () => {
      rerender({ open: false });
    });
    await act(async () => {
      rerender({ open: true });
    });
  };

  /**
   * Change what `GET /api/config` reports, then wait until the dialog has
   * actually heard it.
   *
   * The wait is not politeness. `invalidateQueries` resolves a tick before React
   * commits the new data, and several tests below assert that something did NOT
   * happen — a check made in that gap would pass because nothing had happened
   * YET, which is the one way a test like that can be worthless.
   */
  const serverReports = async (next: Partial<TunnelReport>) => {
    served = { ...served, ...next };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    await waitFor(() => expect(result.current.machine.tunnel).toEqual(served));
  };

  /**
   * Change what the server WOULD answer, without asking it.
   *
   * For the case a real server always produces and a naive fixture never does:
   * `POST /api/tunnel/start` returns only once the tunnel is up, so the very
   * next `GET /api/config` reports it on. A fixture whose config stayed `off`
   * through a successful start describes a server contradicting itself, and the
   * shared model is right to correct the optimism rather than leave the dialog
   * claiming a tunnel nothing can see (ADR 260903-210711).
   */
  const serverNowSays = (next: Partial<TunnelReport>) => {
    served = { ...served, ...next };
  };

  /** Re-answer the config query with the SAME facts, and prove it was re-asked. */
  const serverRepeatsItself = async () => {
    const before = vi.mocked(transport.getConfig).mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    expect(vi.mocked(transport.getConfig).mock.calls.length).toBeGreaterThan(before);
  };

  return { result, transport, serverReports, serverNowSays, serverRepeatsItself, reopenDialog };
}

/** Wait for the first config read to land, so the machine has a server report. */
async function settled(result: { current: { machine: { tunnel?: unknown } } }) {
  await waitFor(() => expect(result.current.machine.tunnel).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module-scope state outlives `cleanup()`, so each case says where it starts.
  resetRemoteAccessStore();
});

afterEach(() => {
  cleanup();
});

describe('a failed start stays on screen (DOR-1739, GitHub #1458)', () => {
  it('holds the error view instead of erasing it a paint later', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      new Error('failed to load ngrok native binding')
    );

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // The whole reported symptom: this used to be 'ready', because the sync
    // effect re-ran on the local `state` change and forced it back to 'off'.
    // The person saw the switch snap back and no reason at all.
    expect(result.current.machine.state).toBe('error');
    expect(result.current.machine.viewState).toBe('error');
    expect(result.current.machine.error).toBe('failed to load ngrok native binding');
  });

  it('survives a config refetch that reports no change', async () => {
    const { result, transport, serverRepeatsItself } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });
    await serverRepeatsItself();

    expect(result.current.machine.viewState).toBe('error');
    expect(result.current.machine.error).toBe('ngrok exploded');
  });

  it('retries the start when the person presses Try again', async () => {
    const { result, transport, serverNowSays } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    await act(async () => {
      await result.current.actions.handleToggle(true);
    });
    expect(result.current.machine.viewState).toBe('error');

    // What the button now does. It used to only clear the error and drop the
    // person back on the switch they had already pressed — a button labelled
    // "Try again" that tried nothing.
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    serverNowSays({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });
    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(2);
    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.error).toBeNull();
  });
});

describe('the dialog outlives every close, so its FIELD errors must not (DOR-1739)', () => {
  // `DialogHost` renders every contribution unconditionally, so this hook is
  // mounted for the life of the app and `open` only gates what is painted.
  // Nothing is ever torn down, which is why none of this clears itself.
  it('clears a refused token save when the dialog is opened again', async () => {
    const { result, transport, reopenDialog } = setup();
    await settled(result);
    vi.mocked(transport.updateConfig).mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await result.current.actions.handleSaveToken();
    });
    expect(result.current.machine.tokenError).not.toBeNull();

    await reopenDialog();

    expect(result.current.machine.tokenError).toBeNull();
    expect(result.current.machine.domainError).toBeNull();
  });

  it('keeps a failed START, so the row’s "Fix…" link lands on the reason (DOR-1743)', async () => {
    // The deliberate reversal. DOR-1739 cleared the tunnel failure on the
    // dialog's opening edge, which was right while the dialog was the only
    // surface. It is not any more: the Control Center row reports the failure
    // continuously and its "Fix…" link exists to open this dialog ONTO it, so
    // clearing on open would empty the dialog that link exists to fill. A
    // failure is ended by something changing — a retry, a saved token, or a new
    // server report — not by being looked at.
    const { result, transport, reopenDialog } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    await reopenDialog();

    expect(result.current.machine.viewState).toBe('error');
    expect(result.current.machine.error).toBe('ngrok exploded');
  });

  it('clears a failed start once a token is saved', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('No ngrok auth token configured'));
    await act(async () => {
      await result.current.actions.handleToggle(true);
    });
    expect(result.current.machine.viewState).toBe('error');

    // Saving a token answers the most common reason a start failed, so the old
    // failure stops being news — and without this the setup view steps aside
    // and drops the person straight back onto it.
    await act(async () => {
      await result.current.actions.handleSaveToken();
    });

    expect(result.current.machine.state).toBe('off');
    expect(result.current.machine.error).toBeNull();
  });
});

describe('the dialog paints what the shared model says', () => {
  it('goes to connected and stays there while the config catches up', async () => {
    const { result, transport, serverReports, serverNowSays } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    serverNowSays({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // Before the fix this read 'ready': the local `setState('connected')`
    // re-ran the sync effect, which still saw `connected: false` from the
    // config it had and forced the dialog back off until the refetch landed.
    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');

    await serverReports({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');
  });

  it('turns the dialog off when the tunnel really does drop', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: false, url: null });

    expect(result.current.machine.state).toBe('off');
    expect(result.current.machine.viewState).toBe('ready');
    expect(result.current.machine.url).toBeNull();
  });

  it('shows a reconnecting tunnel as connected, with a usable switch (DOR-1738)', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    // ngrok dropped the session and is re-establishing it: the listener is still
    // open, so the tunnel is not off — and `url` is still the address the person
    // copied. `connected: false` alone used to be read as OFF.
    await serverReports({ connected: false, isRunning: true });

    expect(result.current.machine.state).toBe('reconnecting');
    expect(result.current.machine.isChecked).toBe(true);
    expect(result.current.machine.viewState).toBe('connected');
    // The switch has to stay usable — turning it off is the way out of a
    // reconnect loop.
    expect(result.current.machine.isTransitioning).toBe(false);
  });

  it('never paints an error over a tunnel that was already up (DOR-1738)', async () => {
    const { result, transport, serverNowSays } = setup();
    await settled(result);
    // "Already running" means the server HAS one, so its config says so too.
    serverNowSays({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Tunnel is already running'), {
        status: 409,
        body: { error: 'Tunnel is already running', url: 'https://abc.ngrok.app' },
      })
    );

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.error).toBeNull();
  });
});
