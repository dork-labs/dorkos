import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListener = {
  url: vi.fn(() => 'https://test.ngrok.io'),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@ngrok/ngrok', () => ({
  forward: vi.fn().mockResolvedValue(mockListener),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({ passcodeEnabled: false, passcodeHash: null }),
  },
}));

import { TunnelManager } from '../tunnel-manager.js';
import { configManager } from '../config-manager.js';

let manager: TunnelManager;

beforeEach(() => {
  vi.clearAllMocks();
  manager = new TunnelManager();
});

describe('TunnelManager', () => {
  it('initial status is disabled and disconnected', () => {
    expect(manager.status).toEqual({
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
      passcodeEnabled: false,
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

  describe('passcodeEnabled', () => {
    it('reports passcodeEnabled true when config has both passcodeEnabled and passcodeHash', () => {
      vi.mocked(configManager.get).mockReturnValue({
        passcodeEnabled: true,
        passcodeHash: 'abc123',
      } as ReturnType<typeof configManager.get>);

      expect(manager.status.passcodeEnabled).toBe(true);
    });

    it('reports passcodeEnabled false when passcodeHash is missing', () => {
      vi.mocked(configManager.get).mockReturnValue({
        passcodeEnabled: true,
        passcodeHash: null,
      } as ReturnType<typeof configManager.get>);

      expect(manager.status.passcodeEnabled).toBe(false);
    });

    it('reports passcodeEnabled false when config flag is false', () => {
      vi.mocked(configManager.get).mockReturnValue({
        passcodeEnabled: false,
        passcodeHash: 'abc123',
      } as ReturnType<typeof configManager.get>);

      expect(manager.status.passcodeEnabled).toBe(false);
    });
  });

  describe('refreshStatus', () => {
    it('emits status_change event', () => {
      const handler = vi.fn();
      manager.on('status_change', handler);

      manager.refreshStatus();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ passcodeEnabled: false }));
    });
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

    it('emits status_change when on_status_change reports connected', async () => {
      const ngrok = await import('@ngrok/ngrok');
      let onStatusChange: ((addr: string, status: string) => void) | undefined;

      (ngrok.forward as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: Record<string, unknown>) => {
          onStatusChange = opts.on_status_change as (addr: string, status: string) => void;
          return mockListener;
        }
      );

      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.start({ port: 4242 });
      handler.mockClear();

      // Simulate ngrok reconnection
      onStatusChange!('localhost:4242', 'connected');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    });

    it('emits status_change when on_status_change reports closed', async () => {
      const ngrok = await import('@ngrok/ngrok');
      let onStatusChange: ((addr: string, status: string) => void) | undefined;

      (ngrok.forward as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: Record<string, unknown>) => {
          onStatusChange = opts.on_status_change as (addr: string, status: string) => void;
          return mockListener;
        }
      );

      const handler = vi.fn();
      manager.on('status_change', handler);

      await manager.start({ port: 4242 });
      handler.mockClear();

      // Simulate ngrok disconnect
      onStatusChange!('localhost:4242', 'closed');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
    });
  });
});
