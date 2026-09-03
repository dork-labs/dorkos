// @vitest-environment jsdom
/**
 * The shared remote-access model, mounted for real.
 *
 * One store, one config query, and the two hooks every surface actually uses —
 * driven over a mock transport with a handle for moving what the SERVER says
 * independently of what the person does. The collision of those two inputs is
 * what this file is about, and it is the collision that produced GitHub #1458.
 *
 * The other half of its job is the property DOR-1743 added: TWO consumers of
 * the model, mounted at once, agreeing. A per-surface `useState` machine passes
 * every single-consumer assertion below and still lets the Control Center row
 * sit at "Off" while the beacon says "On".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { getOwnerSetupRequest, clearOwnerSetupRequest } from '@/layers/shared/lib';
import { useRemoteAccess } from '../model/use-remote-access';
import { useRemoteAccessActions } from '../model/use-remote-access-actions';
import { useRemoteAccessAnnouncer } from '../model/use-remote-access-announcer';
import { resetRemoteAccessStore, useRemoteAccessStore } from '../model/remote-access-store';
import type { TunnelReport } from '../model/tunnel-report';

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
 * Mount the model over one mock transport.
 *
 * `serverReports` moves what `GET /api/config` answers and then WAITS until the
 * model has actually heard it. The wait is not politeness: `invalidateQueries`
 * resolves a tick before React commits the new data, and several cases below
 * assert that something did NOT happen — a check made in that gap would pass
 * because nothing had happened YET, which is the one way a test like that can
 * be worthless.
 */
function setup(initial: Partial<TunnelReport> = {}) {
  let served: TunnelReport = { ...baseTunnel, ...initial };
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const { result } = renderHook(
    () => {
      useRemoteAccessAnnouncer();
      return { remote: useRemoteAccess(), actions: useRemoteAccessActions() };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );

  const serverReports = async (next: Partial<TunnelReport>) => {
    served = { ...served, ...next };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    await waitFor(() => expect(result.current.remote.tunnel).toEqual(served));
  };

  /** Re-answer the config query with the SAME facts, and prove it was re-asked. */
  const serverRepeatsItself = async () => {
    const before = vi.mocked(transport.getConfig).mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    });
    expect(vi.mocked(transport.getConfig).mock.calls.length).toBeGreaterThan(before);
  };

  return { result, transport, queryClient, serverReports, serverRepeatsItself };
}

/** Wait for the first config read to land, so the model has a server report. */
async function settled(result: { current: { remote: { hasServerReport: boolean } } }) {
  await waitFor(() => expect(result.current.remote.hasServerReport).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
  clearOwnerSetupRequest();
});

afterEach(() => {
  cleanup();
});

describe('a failed start stays on screen (DOR-1739, GitHub #1458)', () => {
  it('holds the error instead of erasing it a paint later', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      new Error('failed to load ngrok native binding')
    );

    await act(async () => {
      await result.current.actions.start();
    });

    expect(result.current.remote.state).toBe('error');
    expect(result.current.remote.error).toBe('failed to load ngrok native binding');
  });

  it('survives a config refetch that reports no change', async () => {
    const { result, transport, serverRepeatsItself } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));

    await act(async () => {
      await result.current.actions.start();
    });
    await serverRepeatsItself();

    // A re-read that says the same thing is not news, and must not be allowed
    // to overwrite the newest fact in the room.
    expect(result.current.remote.state).toBe('error');
    expect(result.current.remote.error).toBe('ngrok exploded');
  });

  it('clears when the person tries again and it works', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.remote.state).toBe('error');

    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    await act(async () => {
      await result.current.actions.start();
    });

    expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(2);
    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.error).toBeNull();
  });

  it('clears the moment the server reports anything different', async () => {
    // The half of DOR-1739 that survives the move to a shared model. That fix
    // cleared every error when the DIALOG was reopened, which cannot stay: the
    // Control Center row's "Fix…" link exists to open that dialog ONTO the
    // failure, and clearing on the opening edge would empty it. So a failure is
    // ended by something changing rather than by somebody looking at it.
    const { result, transport, serverReports } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));
    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.remote.error).toBe('ngrok exploded');

    await serverReports({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.error).toBeNull();
  });
});

describe('a successful start does not flicker', () => {
  it('goes to connected and stays there while the config catches up', async () => {
    const { result, transport, serverReports } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.actions.start();
    });

    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.url).toBe('https://abc.ngrok.app');
    expect(result.current.remote.host).toBe('abc.ngrok.app');

    await serverReports({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.url).toBe('https://abc.ngrok.app');
  });

  it('stays connecting while the start request is still in flight', async () => {
    // Past the 15s timer this used to arm, and still well inside the
    // transport's own 30s request window (DOR-1739).
    vi.useFakeTimers();
    try {
      const { result, transport } = setup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      let settleStart: (value: { url: string }) => void = () => {};
      vi.mocked(transport.startTunnel).mockReturnValue(
        new Promise<{ url: string }>((resolve) => {
          settleStart = resolve;
        })
      );

      let started: Promise<void> | undefined;
      act(() => {
        started = result.current.actions.start();
      });
      expect(result.current.remote.state).toBe('starting');
      expect(result.current.remote.isTransitioning).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(result.current.remote.state).toBe('starting');
      expect(result.current.remote.error).toBeNull();

      await act(async () => {
        settleStart({ url: 'https://slow-but-fine.ngrok.app' });
        await started;
      });
      expect(result.current.remote.state).toBe('connected');
      expect(result.current.remote.url).toBe('https://slow-but-fine.ngrok.app');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the server still gets the last word when it has news', () => {
  it('turns off when the tunnel really does drop', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: false, url: null });

    expect(result.current.remote.state).toBe('off');
    expect(result.current.remote.url).toBeNull();
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
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: true });

    expect(result.current.remote.state).toBe('reconnecting');
    expect(result.current.remote.isChecked).toBe(true);
    expect(result.current.remote.isLive).toBe(true);
    expect(result.current.remote.url).toBe('https://abc.ngrok.app');
    // The switch has to stay usable — turning it off is the way out of a
    // reconnect loop.
    expect(result.current.remote.isTransitioning).toBe(false);
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

    expect(result.current.remote.state).toBe('connected');
  });

  it('still reads a real stop as off, not as reconnecting', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await serverReports({ connected: false, isRunning: false, url: null });

    expect(result.current.remote.state).toBe('off');
    expect(result.current.remote.isChecked).toBe(false);
    expect(result.current.remote.isLive).toBe(false);
  });
});

describe('what counts as live, which is the beacon’s whole visibility rule', () => {
  it.each([
    ['starting', true],
    ['connected', true],
    ['reconnecting', true],
    ['stopping', true],
    ['off', false],
    ['error', false],
  ] as const)('%s → %s', async (state, live) => {
    const { result, transport } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

    if (state === 'starting') {
      act(() => useRemoteAccessStore.getState().beginStart());
    } else if (state === 'reconnecting') {
      act(() => useRemoteAccessStore.getState().convergeStart(null));
    } else if (state === 'stopping') {
      // A stop that never settles, so the in-flight state can be observed.
      vi.mocked(transport.stopTunnel).mockReturnValue(new Promise<void>(() => {}));
      act(() => void result.current.actions.stop());
    } else if (state === 'off') {
      act(() => useRemoteAccessStore.getState().settleStop());
    } else if (state === 'error') {
      act(() => useRemoteAccessStore.getState().failStart('ngrok exploded'));
    }

    expect(result.current.remote.state).toBe(state);
    expect(result.current.remote.isLive).toBe(live);
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
      await result.current.actions.start();
    });

    // Painting "Tunnel failed" over a live tunnel is how somebody ends up
    // turning off working remote access in order to fix it.
    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.url).toBe('https://abc.ngrok.app');
    expect(result.current.remote.error).toBeNull();
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
      await result.current.actions.start();
    });

    expect(result.current.remote.state).toBe('reconnecting');
    expect(result.current.remote.error).toBeNull();
  });

  it('routes the exposure 409 into owner setup instead', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Exposing DorkOS requires a login. Create an owner account first.'), {
        status: 409,
        code: 'AUTH_REQUIRED_FOR_EXPOSURE',
      })
    );

    await act(async () => {
      await result.current.actions.start();
    });

    // Both refusals are 409s; only one of them means the tunnel is up.
    const request = getOwnerSetupRequest();
    expect(request?.reason).toBe('exposure');
    expect(request?.message).toBe('Exposing DorkOS requires a login.');
    expect(result.current.remote.state).toBe('off');
    expect(result.current.remote.error).toBeNull();
  });

  it('resumes the start once the owner account exists', async () => {
    // The half of the exposure guard nothing asserted: routing somebody into
    // owner setup is only useful if the thing they asked for happens
    // afterwards. `onComplete` fires long after the render that armed it, so
    // this also pins that the retry ref is tracking the LATEST start closure.
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Exposing DorkOS requires a login.'), {
        status: 409,
        code: 'AUTH_REQUIRED_FOR_EXPOSURE',
      })
    );
    await act(async () => {
      await result.current.actions.start();
    });
    expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(1);

    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    await act(async () => {
      getOwnerSetupRequest()?.onComplete();
    });

    await waitFor(() => expect(vi.mocked(transport.startTunnel)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    expect(result.current.remote.url).toBe('https://abc.ngrok.app');
  });
});

describe('stopping', () => {
  it('goes off, and keeps nothing to copy', async () => {
    const { result, transport } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);

    await act(async () => {
      await result.current.actions.stop();
    });

    expect(result.current.remote.state).toBe('off');
    expect(result.current.remote.url).toBeNull();
  });

  it('stays on, and says why, when the stop is refused', async () => {
    const { result, transport } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockRejectedValue(new Error('could not stop'));

    await act(async () => {
      await result.current.actions.stop();
    });

    expect(result.current.remote.state).toBe('connected');
    expect(result.current.remote.error).toBe('could not stop');
  });
});

describe('status toasts speak only for changes the person did not make', () => {
  it('says nothing when the person turns remote access off themselves', async () => {
    const { result, transport, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);

    await act(async () => {
      await result.current.actions.stop();
    });
    await serverReports({ connected: false, isRunning: false, url: null });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('speaks up for a drop nobody asked for, without promising a reconnect', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

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
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: true });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title] = vi.mocked(toast.warning).mock.calls[0] ?? [];
    expect(title).toMatch(/reconnecting/i);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still reports a real drop after a stop that failed', async () => {
    const { result, transport, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockRejectedValue(new Error('could not stop'));

    // The stop is asked for and refused, so nothing changes and no toast is
    // owed. The suppression must not survive that: the drop below is a
    // different event and the person has not been told about it.
    await act(async () => {
      await result.current.actions.stop();
    });
    expect(toast.error).not.toHaveBeenCalled();

    await serverReports({ connected: false, isRunning: false, url: null });

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('says nothing on load, however the tunnel already was', async () => {
    const { result } = setup({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('announces a recovery nobody asked for, with the address back', async () => {
    const { result, serverReports } = setup({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('connected'));
    await serverReports({ connected: false, isRunning: true });

    await serverReports({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    expect(toast.success).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast.success).mock.calls[0] ?? [];
    expect(title).toBe('Remote access is on');
    expect((options as { description?: string })?.description).toBe('https://abc.ngrok.app');
  });

  it('still reports a real drop after a start that converged on a 409', async () => {
    // A start that 409s changes nothing — the tunnel was already up — so the
    // refetch reports no transition and there is nothing for the suppression to
    // be consumed by. Left armed, it would sit there until the next genuine drop
    // and eat the one toast that mattered.
    const { result, transport, serverReports } = setup({ connected: true, url: null });
    await settled(result);
    await waitFor(() => expect(result.current.remote.state).toBe('off'));

    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Tunnel is already running'), {
        status: 409,
        body: { error: 'Tunnel is already running', url: null },
      })
    );
    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.remote.state).toBe('reconnecting');
    expect(toast.error).not.toHaveBeenCalled();

    await serverReports({ connected: false, isRunning: false, url: null });

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for the start the person just asked for', async () => {
    const { result, transport, serverReports } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.actions.start();
    });
    await serverReports({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('two surfaces, one answer (DOR-1743)', () => {
  /**
   * The property a per-surface machine cannot have.
   *
   * Mounts the model TWICE — the shape the app is really in, with the Control
   * Center row, the beacon and the dialog all reading it — and acts through one
   * of them.
   */
  function setupTwo(initial: Partial<TunnelReport> = {}) {
    let served: TunnelReport = { ...baseTunnel, ...initial };
    const transport: Transport = createMockTransport({
      getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(
      () => {
        // The shell's single announcer, plus two independent consumers —
        // exactly as two components would be.
        useRemoteAccessAnnouncer();
        return {
          rowView: useRemoteAccess(),
          beaconView: useRemoteAccess(),
          rowActions: useRemoteAccessActions(),
        };
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={transport}>{children}</TransportProvider>
          </QueryClientProvider>
        ),
      }
    );

    const serverReports = async (next: Partial<TunnelReport>) => {
      served = { ...served, ...next };
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: configKeys.all });
      });
      await waitFor(() => expect(result.current.rowView.tunnel).toEqual(served));
    };

    return { result, transport, serverReports };
  }

  it('a tunnel one surface starts is on for the other, before the config catches up', async () => {
    const { result, transport } = setupTwo();
    await waitFor(() => expect(result.current.rowView.hasServerReport).toBe(true));
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });

    await act(async () => {
      await result.current.rowActions.start();
    });

    expect(result.current.rowView.state).toBe('connected');
    expect(result.current.beaconView.state).toBe('connected');
    expect(result.current.beaconView.url).toBe('https://abc.ngrok.app');
    expect(result.current.beaconView.isLive).toBe(true);
  });

  it('a failure one surface hit is a failure the other can offer to fix', async () => {
    const { result, transport } = setupTwo();
    await waitFor(() => expect(result.current.rowView.hasServerReport).toBe(true));
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));

    await act(async () => {
      await result.current.rowActions.start();
    });

    expect(result.current.beaconView.state).toBe('error');
    expect(result.current.beaconView.error).toBe('ngrok exploded');
    // …and the beacon still draws nothing, because a failure is not a tunnel.
    expect(result.current.beaconView.isLive).toBe(false);
  });

  it('reduces one server report once, however many surfaces are watching', async () => {
    const { result, serverReports } = setupTwo({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await waitFor(() => expect(result.current.rowView.state).toBe('connected'));

    await serverReports({ connected: false, isRunning: true });

    expect(result.current.rowView.state).toBe('reconnecting');
    expect(result.current.beaconView.state).toBe('reconnecting');
    // Two consumers each run the reduction effect; the change gate lives in the
    // store, so the report lands once and is announced once.
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('does not announce a stop the person made from another surface', async () => {
    // The double-toast the split would otherwise produce. The suppression flag
    // is armed by the ACTION hook and consumed by the ANNOUNCER, which are
    // different hooks in different components — it only works because both
    // reach the same store.
    const { result, transport, serverReports } = setupTwo({
      connected: true,
      isRunning: true,
      url: 'https://abc.ngrok.app',
    });
    await waitFor(() => expect(result.current.rowView.state).toBe('connected'));
    vi.mocked(transport.stopTunnel).mockResolvedValue(undefined);

    await act(async () => {
      await result.current.rowActions.stop();
    });
    await serverReports({ connected: false, isRunning: false, url: null });

    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.rowView.state).toBe('off');
    expect(result.current.beaconView.state).toBe('off');
  });
});
