import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListener = {
  url: vi.fn(() => 'https://test.ngrok.io'),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@ngrok/ngrok', () => ({
  forward: vi.fn().mockResolvedValue(mockListener),
}));

import { TunnelManager } from '../tunnel-manager.js';

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
    });
  });

  it('calls ngrok.forward() with correct options', async () => {
    const ngrok = await import('@ngrok/ngrok');
    await manager.start({ port: 4242 });

    expect(ngrok.forward).toHaveBeenCalledWith({
      addr: 4242,
      authtoken_from_env: true,
    });
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
});
