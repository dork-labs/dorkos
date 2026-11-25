// @vitest-environment jsdom
/** The shared remote-access model, mounted for real. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
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

/** How the cockpit was started, for the cases where that is the subject. */
interface SetupOptions {
  /** What the browser remembers about the tunnel from a PREVIOUS launch. */
  remembered?: Partial<TunnelReport>;
}

/**
 * Seed the config query the way a warm boot does.
 *
 * **The real mechanism, not a mime of it.** `['config','current']` is on the
 * boot cache's allow-list (`shared/lib/boot-cache-keys.ts`), so the WHOLE
 * config — tunnel block included — is written to `localStorage` and restored on
 * the next load, up to 24 hours later. `hydrate` restores the entry with the
 * `dataUpdatedAt` of its ORIGINAL fetch rather than restamping it to now, which
 * is the only reason a launch comparison can tell the two apart. `setState` is
 * the exact lever it pulls.
 *
 * @param client - The query client the model will read from.
 * @param tunnel - The tunnel block as it was when the blob was written.
 */
function rememberFromLastLaunch(client: QueryClient, tunnel: Partial<TunnelReport>): void {
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  client.setQueryData(configKeys.current(), {
    tunnel: { ...baseTunnel, ...tunnel },
  } as unknown as ServerConfig);
  client.getQueryCache().find({ queryKey: configKeys.current() })?.setState({
    dataUpdatedAt: anHourAgo,
  });
}

/** Mount the model over one mock transport. */
function setup(initial: Partial<TunnelReport> = {}, options: SetupOptions = {}) {
  let served: TunnelReport = { ...baseTunnel, ...initial };
  const transport: Transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel: served } as unknown as ServerConfig)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.remembered !== undefined) rememberFromLastLaunch(queryClient, options.remembered);

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

  /** Change what the server WOULD answer, without asking it. */
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

  return {
    result,
    transport,
    queryClient,
    serverReports,
    serverNowSays,
    serverRepeatsItself,
  };
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
});

describe('a successful start does not flicker', () => {
  it('goes to connected and stays there while the config catches up', async () => {
    const { result, transport, serverReports, serverNowSays } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://abc.ngrok.app' });
    // What a real server does: the start call returns only once the tunnel is
    // up, so config agrees from the next read onward.
    serverNowSays({ connected: true, isRunning: true, url: 'https://abc.ngrok.app' });

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
});

describe('the change gate cannot park live chrome over a dead tunnel', () => {
  it('corrects an optimistic connect the server never confirms', async () => {
    // The failure the tuple-only gate allowed: `settleStart` writes `connected` while the last
    // report was {off,null}; every later report is ALSO {off,null}, so the tuple never changes
    // and the gate blocks forever.
    const { result, transport, serverRepeatsItself } = setup();
    await settled(result);
    // The server answers `off` throughout — a start that reported a URL over a
    // tunnel it does not actually have.
    vi.mocked(transport.startTunnel).mockResolvedValue({ url: 'https://ghost.ngrok.app' });

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.remote.state).toBe('connected');

    // The server is asked again and says `off` again. Same facts — but it has
    // now SPOKEN over a state it owns and disagrees with.
    await serverRepeatsItself();

    await waitFor(() => expect(result.current.remote.state).toBe('off'));
    expect(result.current.remote.url).toBeNull();
    expect(result.current.remote.isLive).toBe(false);
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
      Object.assign(new Error('Remote access is already on.'), {
        status: 409,
        code: 'tunnel_running',
        body: {
          code: 'tunnel_running',
          status: 409,
          detail: 'Remote access is already on.',
          url: 'https://abc.ngrok.app',
        },
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

  it('routes the exposure 409 into owner setup instead', async () => {
    const { result, transport } = setup();
    await settled(result);
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error('Exposing DorkOS requires a login. Create an owner account first.'), {
        status: 409,
        code: 'auth_required_for_exposure',
      })
    );

    await act(async () => {
      await result.current.actions.start();
    });

    // Both refusals are 409s; only one of them means the tunnel is up.
    const request = getOwnerSetupRequest();
    expect(request?.reason).toBe('exposure');
    expect(request?.message).toBe('Remote access needs a login.');
    expect(result.current.remote.state).toBe('off');
    expect(result.current.remote.error).toBeNull();
  });

  it('says a TUNNEL_PORT refusal as an error, never as a tunnel that is up (DOR-4263)', async () => {
    const { result, transport } = setup();
    await settled(result);
    const sentence = 'Remote access can’t reach that port. Unset TUNNEL_PORT, or fix it.';
    vi.mocked(transport.startTunnel).mockRejectedValue(
      Object.assign(new Error(sentence), {
        status: 409,
        code: 'tunnel_port_mismatch',
        body: { code: 'tunnel_port_mismatch', status: 409, detail: sentence },
      })
    );

    await act(async () => {
      await result.current.actions.start();
    });

    expect(result.current.remote.state).not.toBe('connected');
    expect(result.current.remote.state).not.toBe('reconnecting');
    expect(result.current.remote.error).toBe(sentence);
    expect(getOwnerSetupRequest()).toBeNull();
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
});

describe('two readers, one reduction (DOR-1743)', () => {
  /**
   * The model mounted TWICE — the shape the app is really in, with the row, the beacon and the
   * dialog all reading it.
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
});

describe('a tunnel the browser remembers is not a tunnel that is up', () => {
  /** The warm-boot half of the model, and the reason it needs its own block. */

  it('does not offer a link to a tunnel that stopped since the last launch', async () => {
    // The concrete harm: the beacon draws only when remote access `isLive`, and what it draws is
    // a copyable URL and a QR code.
    const { result } = setup(
      { connected: false, isRunning: false, url: null },
      { remembered: { connected: true, isRunning: true, url: 'https://gone.ngrok.app' } }
    );

    // Asserted on the FIRST paint, before the real read lands, because that is the whole of the
    // defect: the remembered answer is what the first frame reduces.
    expect(result.current.remote.isLive).toBe(false);
    expect(result.current.remote.url).toBeNull();
    expect(result.current.remote.hasServerReport).toBe(false);

    await settled(result);
    expect(result.current.remote.state).toBe('off');
  });
});
