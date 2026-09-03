import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListener = {
  url: vi.fn<() => string | null>(() => 'https://test.ngrok.io'),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

vi.mock('@ngrok/ngrok', () => ({
  forward: vi.fn().mockResolvedValue(mockListener),
}));

import { TunnelManager } from '../tunnel-manager.js';

let manager: TunnelManager;

beforeEach(() => {
  vi.clearAllMocks();
  mockListener.url.mockReturnValue('https://test.ngrok.io');
  mockListener.close.mockResolvedValue(undefined);
  manager = new TunnelManager();
});

/**
 * Arm `ngrok.forward` so the next `start()` hands back a way to drive the
 * status callback, then return that driver.
 *
 * It reads `onStatusChange` — the SDK's own spelling, taking ONE argument —
 * rather than whatever key this module happens to pass. That is the whole point:
 * the previous version of these tests read `on_status_change`, which meant it
 * pinned a misspelling the real SDK never reads, and reported a disconnect
 * handler that could not fire (DOR-1738). See the SDK's `forward()`, which
 * checks `config["onStatusChange"]` and calls it as `(status)`.
 */
async function captureStatusCallback(): Promise<(status: string) => void> {
  const ngrok = await import('@ngrok/ngrok');
  let onStatusChange: ((status: string) => void) | undefined;
  (ngrok.forward as ReturnType<typeof vi.fn>).mockImplementation(
    async (opts: Record<string, unknown>) => {
      onStatusChange = opts.onStatusChange as (status: string) => void;
      return mockListener;
    }
  );
  return (status: string) => {
    if (!onStatusChange) throw new Error('ngrok.forward was given no onStatusChange callback');
    onStatusChange(status);
  };
}

describe('TunnelManager', () => {
  it('initial status is disabled and disconnected', () => {
    expect(manager.status).toEqual({
      enabled: false,
      connected: false,
      isRunning: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    });
  });

  it('calls ngrok.forward() with correct options', async () => {
    const ngrok = await import('@ngrok/ngrok');
    await manager.start({ port: 4242 });

    expect(ngrok.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        addr: 4242,
        authtoken_from_env: true,
      })
    );
  });

  it('passes basic_auth array when configured', async () => {
    const ngrok = await import('@ngrok/ngrok');
    await manager.start({ port: 4242, basicAuth: 'user:pass' });

    expect(ngrok.forward).toHaveBeenCalledWith(
      expect.objectContaining({ basic_auth: ['user:pass'] })
    );
  });

  it('passes domain when configured', async () => {
    const ngrok = await import('@ngrok/ngrok');
    await manager.start({ port: 4242, domain: 'my.ngrok.app' });

    expect(ngrok.forward).toHaveBeenCalledWith(expect.objectContaining({ domain: 'my.ngrok.app' }));
  });

  it('uses explicit authtoken over authtoken_from_env', async () => {
    const ngrok = await import('@ngrok/ngrok');
    await manager.start({ port: 4242, authtoken: 'my-token' });

    const callArgs = (ngrok.forward as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.authtoken).toBe('my-token');
    expect(callArgs.authtoken_from_env).toBeUndefined();
  });

  it('throws if already running', async () => {
    await manager.start({ port: 4242 });
    await expect(manager.start({ port: 4242 })).rejects.toThrow('Tunnel is already running');
  });

  describe('isRunning', () => {
    it('is false before a start and true after one', async () => {
      expect(manager.isRunning).toBe(false);
      await manager.start({ port: 4242 });
      expect(manager.isRunning).toBe(true);
    });

    it('is false again after stop()', async () => {
      await manager.start({ port: 4242 });
      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it('stays true while ngrok reports a transient disconnect (DOR-1738)', async () => {
      // The half-dead case. `status.connected` follows ngrok's own
      // onStatusChange, so a dropped connection flips it to false while the
      // listener is still open and start() would still throw. Anything asking
      // "may I start one?" has to ask isRunning, not status.connected — asking
      // the latter turned a reconnecting tunnel into a 500 on /api/tunnel/start.
      const notify = await captureStatusCallback();

      await manager.start({ port: 4242 });
      notify('closed');

      expect(manager.status.connected).toBe(false);
      expect(manager.isRunning).toBe(true);
      await expect(manager.start({ port: 4242 })).rejects.toThrow('Tunnel is already running');
    });

    it('rides the status object, so a reader can tell reconnecting from off', async () => {
      // Everything that reads the tunnel over HTTP or SSE reads `status`, not
      // this class. Without the field there, a live-but-reconnecting tunnel and
      // no tunnel at all are the same two booleans — which is how a reader ends
      // up showing Remote Access off and then offering a start that is refused.
      const notify = await captureStatusCallback();
      await manager.start({ port: 4242 });

      expect(manager.status).toMatchObject({ isRunning: true, connected: true });

      notify('closed');
      expect(manager.status).toMatchObject({ isRunning: true, connected: false });

      await manager.stop();
      expect(manager.status).toMatchObject({ isRunning: false, connected: false });
    });

    it('is emitted on the status_change event, not only on a fresh read', async () => {
      // The SSE `tunnel_status` event carries whatever the emitter passed, so a
      // field composed only into the getter would be missing from every push.
      const notify = await captureStatusCallback();
      const handler = vi.fn();
      await manager.start({ port: 4242 });
      manager.on('status_change', handler);

      notify('closed');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true, connected: false })
      );
    });
  });

  it('stop() calls listener.close()', async () => {
    await manager.start({ port: 4242 });
    await manager.stop();

    expect(mockListener.close).toHaveBeenCalled();
    expect(manager.status.connected).toBe(false);
    expect(manager.status.url).toBeNull();
  });

  it('stop() is safe when not running', async () => {
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('status returns an immutable copy', async () => {
    await manager.start({ port: 4242 });
    const status1 = manager.status;
    status1.url = 'tampered';
    expect(manager.status.url).toBe('https://test.ngrok.io');
  });

  describe('EventEmitter', () => {
    it('emits status_change on start', async () => {
      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.start({ port: 4242 });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, connected: true, url: 'https://test.ngrok.io' })
      );
    });

    it('emits status_change on stop', async () => {
      await manager.start({ port: 4242 });

      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.stop();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, connected: false, url: null })
      );
    });

    it('registers its disconnect handler under the key the SDK actually reads', async () => {
      // The regression this file missed for as long as it existed: the option
      // was passed as `on_status_change`, which @ngrok/ngrok never looks at, so
      // no drop was ever reported and DorkOS showed a dead tunnel as connected.
      const ngrok = await import('@ngrok/ngrok');
      await manager.start({ port: 4242 });

      const opts = (ngrok.forward as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof opts.onStatusChange).toBe('function');
      expect(opts.on_status_change).toBeUndefined();
    });

    it('emits status_change when ngrok reports connected', async () => {
      const notify = await captureStatusCallback();
      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.start({ port: 4242 });
      handler.mockClear();

      // Simulate ngrok reconnection
      notify('connected');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    });

    it('emits status_change when ngrok reports closed', async () => {
      const notify = await captureStatusCallback();
      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.start({ port: 4242 });
      handler.mockClear();

      // Simulate ngrok disconnect
      notify('closed');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
    });
  });

  describe('when ngrok misbehaves', () => {
    it('treats a listener with no URL as a failed start, and closes it', async () => {
      // Reporting an empty URL as success showed Remote Access as on with a
      // blank address, and left something unusable "running" so every later
      // start was refused (DOR-1738).
      mockListener.url.mockReturnValue(null);

      await expect(manager.start({ port: 4242 })).rejects.toThrow('no public URL');
      expect(mockListener.close).toHaveBeenCalled();
      expect(manager.isRunning).toBe(false);
      expect(manager.status.connected).toBe(false);
      expect(manager.status.url).toBeNull();
    });

    it('lets go of the listener even when close() rejects (DOR-1738)', async () => {
      // A failing close used to strand the manager: listener non-null, status
      // still connected — so the tunnel origin stayed trusted, every later stop
      // retried the same doomed close, and every start was refused.
      await manager.start({ port: 4242 });
      mockListener.close.mockRejectedValue(new Error('ngrok agent is gone'));

      await expect(manager.stop()).rejects.toThrow('ngrok agent is gone');

      expect(manager.isRunning).toBe(false);
      expect(manager.status.connected).toBe(false);
      expect(manager.status.url).toBeNull();

      // And the manager is genuinely usable again, not merely reporting so.
      mockListener.close.mockResolvedValue(undefined);
      await expect(manager.start({ port: 4242 })).resolves.toBe('https://test.ngrok.io');
    });
  });
});
