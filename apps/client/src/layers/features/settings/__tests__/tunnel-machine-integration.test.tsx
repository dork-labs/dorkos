// @vitest-environment jsdom
/**
 * The Remote Access machine and its actions, mounted TOGETHER.
 *
 * `use-tunnel-actions.test.ts` drives the actions over a fake machine of spies,
 * which can prove a setter was called and nothing else. The bug this file exists
 * for lives in the gap that leaves: the sync effect ran AFTER the action's
 * setter and undid it, so every one of those assertions passed while the dialog
 * showed the opposite. Only the real hooks, wired to each other, can see it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { useTunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

/** The DTO plus the `isRunning` field DOR-1738 is adding to it. */
type Tunnel = NonNullable<ServerConfig['tunnel']> & { isRunning?: boolean };

const baseTunnel = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: true,
  domain: null,
} as unknown as Tunnel;

/**
 * Mount the real machine and the real actions over one mock transport, with a
 * handle for moving what the SERVER reports independently of what the person
 * does — the two inputs whose collision is the whole subject of this file.
 */
function setup(initial: Partial<Tunnel> = {}) {
  let served: Tunnel = { ...baseTunnel, ...initial };
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const { result } = renderHook(
    () => {
      // `open: false` — the latency probe is not under test and would put a
      // real `fetch` at an ngrok URL from jsdom.
      const machine = useTunnelMachine({ open: false });
      return { machine, actions: useTunnelActions({ machine, transport, queryClient }) };
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );

  /**
   * Change what `GET /api/config` reports, then wait until the dialog has
   * actually heard it.
   *
   * The wait is not politeness. `invalidateQueries` resolves a tick before React
   * commits the new data, and several tests below assert that something did NOT
   * happen — a check made in that gap would pass because nothing had happened
   * YET, which is the one way a test like that can be worthless.
   */
  const serverReports = async (next: Partial<Tunnel>) => {
    served = { ...served, ...next };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    await waitFor(() => expect(result.current.machine.tunnel).toEqual(served));
  };

  /** Re-answer the config query with the SAME facts, and prove it was re-asked. */
  const serverRepeatsItself = async () => {
    const before = vi.mocked(transport.getConfig).mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    expect(vi.mocked(transport.getConfig).mock.calls.length).toBeGreaterThan(before);
  };

  return { result, transport, serverReports, serverRepeatsItself };
}

/** Wait for the first config read to land, so the machine has a server report. */
async function settled(result: { current: { machine: { tunnel?: unknown } } }) {
  await waitFor(() => expect(result.current.machine.tunnel).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
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

    // A re-read that says the same thing is not news, and must not be allowed
    // to overwrite the newest fact in the room.
    expect(result.current.machine.viewState).toBe('error');
    expect(result.current.machine.error).toBe('ngrok exploded');
  });

  it('clears only when the person asks it to', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // What the "Try again" button does — reachable now that the view persists.
    act(() => {
      result.current.machine.setState('off');
      result.current.machine.setError(null);
    });

    expect(result.current.machine.viewState).toBe('ready');
  });
});

describe('a successful start does not flicker', () => {
  it('goes to connected and stays there while the config catches up', async () => {
    const { result, transport, serverReports } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // Before the fix this read 'ready': the local `setState('connected')`
    // re-ran the sync effect, which still saw `connected: false` from the
    // config it had and forced the dialog back off until the refetch landed.
    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');

    await serverReports({ connected: true, url: 'https://abc.ngrok.app' });

    expect(result.current.machine.viewState).toBe('connected');
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');
  });
});

describe('the server still gets the last word when it has news', () => {
  it('turns the dialog off when the tunnel really does drop', async () => {
    const { result, serverReports } = setup({ connected: true, url: 'https://abc.ngrok.app' });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    await serverReports({ connected: false, url: null });

    expect(result.current.machine.state).toBe('off');
    expect(result.current.machine.url).toBeNull();
  });
});

describe('a reconnecting tunnel is still ON (DOR-1738)', () => {
  it('keeps the switch on and the URL, instead of reading as turned off', async () => {
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
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');
    expect(result.current.machine.viewState).toBe('connected');
    // The switch has to stay usable — turning it off is the way out of a
    // reconnect loop.
    expect(result.current.machine.isTransitioning).toBe(false);
  });

  it('settles back to connected when ngrok recovers', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await serverReports({ connected: false, isRunning: true });
    await serverReports({ connected: true, isRunning: true });

    expect(result.current.machine.state).toBe('connected');
  });

  it('still reads a real stop as off, not as reconnecting', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await serverReports({ connected: false, isRunning: false, url: null });

    expect(result.current.machine.state).toBe('off');
    expect(result.current.machine.isChecked).toBe(false);
  });

  it('behaves exactly as before against a server with no isRunning field', async () => {
    // The whole point of the `?? connected` fallback: this branch has to be
    // shippable before DOR-1738 lands, and on an older server `reconnecting`
    // must be unreachable rather than sticky.
    const { result, serverReports } = setup({ connected: true, url: 'https://abc.ngrok.app' });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    await serverReports({ connected: false, url: null });

    expect(result.current.machine.state).toBe('off');
  });
});

describe('a start against a tunnel that is already up converges (DOR-1738)', () => {
  it('lands on connected with the URL the 409 carried, not on an error', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Tunnel is already running'), {
        status: 409,
        body: { error: 'Tunnel is already running', url: 'https://abc.ngrok.app' },
      })
    );

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // Painting "Tunnel failed" over a live tunnel is how somebody ends up
    // turning off working remote access in order to fix it.
    expect(result.current.machine.state).toBe('connected');
    expect(result.current.machine.url).toBe('https://abc.ngrok.app');
    expect(result.current.machine.viewState).not.toBe('error');
    expect(result.current.machine.error).toBeNull();
  });

  it('lands on reconnecting when the 409 names no URL', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Tunnel is already running'), {
        status: 409,
        body: { error: 'Tunnel is already running' },
      })
    );

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    expect(result.current.machine.state).toBe('reconnecting');
    expect(result.current.machine.viewState).not.toBe('error');
  });

  it('still routes the exposure 409 into owner setup', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Exposing DorkOS requires a login.'), {
        status: 409,
        code: 'AUTH_REQUIRED_FOR_EXPOSURE',
      })
    );

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });

    // Both refusals are 409s; only one of them means the tunnel is up.
    expect(result.current.machine.state).toBe('off');
  });
});

describe('status toasts speak only for changes the person did not make', () => {
  it('says nothing when the person turns remote access off themselves', async () => {
    const { result, transport, serverReports } = setup({
      connected: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);

    await act(async () => {
      await result.current.actions.handleToggle(false);
    });
    await serverReports({ connected: false, url: null });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('speaks up for a drop nobody asked for, without promising a reconnect', async () => {
    const { result, serverReports } = setup({ connected: true, url: 'https://abc.ngrok.app' });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    // Gone for good: the listener is closed, so nothing is retrying.
    await serverReports({ connected: false, isRunning: false, url: null });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(title).toBe('Remote access turned off');
    expect(String((options as { description?: string })?.description)).not.toMatch(/reconnect/i);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('promises a reconnect only where one is actually happening', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: true });

    // ngrok's own agent retries the session and emits `connected` again on
    // recovery, so here — and only here — "reconnecting" is a true statement.
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title] = vi.mocked(toast.warning).mock.calls[0] ?? [];
    expect(title).toMatch(/reconnecting/i);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still reports a real drop after a stop that failed', async () => {
    const { result, transport, serverReports } = setup({
      connected: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.machine.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockRejectedValue(new Error('could not stop'));

    // The stop is asked for and refused, so nothing changes and no toast is
    // owed. The suppression must not survive that: the drop below is a
    // different event and the person has not been told about it.
    await act(async () => {
      await result.current.actions.handleToggle(false);
    });
    expect(toast.error).not.toHaveBeenCalled();

    await serverReports({ connected: false, url: null });

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for the start the person just asked for', async () => {
    const { result, transport, serverReports } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.actions.handleToggle(true);
    });
    await serverReports({ connected: true, url: 'https://abc.ngrok.app' });

    expect(toast.success).not.toHaveBeenCalled();
  });
});
