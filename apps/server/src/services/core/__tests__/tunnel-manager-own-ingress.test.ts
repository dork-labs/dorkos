import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedIngress } from '../remote/managed-ingress.js';
import type { OwnTunnelIngress } from '../remote/own-tunnel-ingress.js';

const mockListener = {
  url: vi.fn<() => string | null>(() => 'https://test.ngrok.io'),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

vi.mock('@ngrok/ngrok', () => ({
  forward: vi.fn(),
  disconnect: vi.fn(),
}));

const ngrok = await import('@ngrok/ngrok');
const forward = ngrok.forward as unknown as ReturnType<typeof vi.fn>;
const { TunnelManager } = await import('../tunnel-manager.js');

/** A fake own-tunnel ingress fronting port 4242, recording opens and closes. */
function fakeIngress() {
  return {
    fronts: vi.fn((port: number) => port === 4242),
    open: vi.fn(async () => 'http://127.0.0.1:50123'),
    close: vi.fn(async () => undefined),
  } satisfies OwnTunnelIngress;
}

let ingress: ReturnType<typeof fakeIngress>;
let manager: InstanceType<typeof TunnelManager>;

beforeEach(() => {
  vi.clearAllMocks();
  mockListener.url.mockReturnValue('https://test.ngrok.io');
  forward.mockResolvedValue(mockListener);
  ingress = fakeIngress();
  manager = new TunnelManager();
  manager.attachIngresses({ managed: {} as ManagedIngress, ownTunnel: ingress });
});

describe('TunnelManager and the own-tunnel ingress', () => {
  // Purpose: aimed at the main server's port, ngrok must forward into the
  // marking ingress, never at the main port, or tunnel traffic with a
  // rewritten Host reads as this computer.
  it('forwards into the ingress when the tunnel targets the main port', async () => {
    await manager.start({ port: 4242 });
    expect(ingress.open).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ addr: 'http://127.0.0.1:50123' })
    );
    // The person still sees the port they asked for.
    expect(manager.status.port).toBe(4242);
  });

  // Purpose: in development the app is on the Vite port, which the front door
  // does not serve, so the tunnel must keep forwarding there directly.
  it('forwards directly when the tunnel targets another port', async () => {
    await manager.start({ port: 6241 });
    expect(ingress.open).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ addr: 6241 }));
  });

  // Purpose: stopping the tunnel must leave no loopback listener behind.
  it('closes the ingress when the tunnel stops', async () => {
    await manager.start({ port: 4242 });
    await manager.stopOwnTunnel();
    expect(ingress.close).toHaveBeenCalled();
  });

  // Purpose: while ngrok may still be forwarding, the ingress must stay open.
  // Closing it would free its port, and whatever bound there next would be
  // public. Once a later close of ngrok succeeds, the ingress closes too.
  it('keeps the ingress open while ngrok refuses to close, and closes it after', async () => {
    await manager.start({ port: 4242 });
    const disconnect = ngrok.disconnect as unknown as ReturnType<typeof vi.fn>;
    mockListener.close.mockRejectedValueOnce(new Error('ngrok said no'));
    disconnect.mockRejectedValueOnce(new Error('still no'));
    await expect(manager.stopOwnTunnel()).rejects.toThrow('ngrok said no');
    expect(ingress.close).not.toHaveBeenCalled();

    await manager.stopOwnTunnel();
    expect(ingress.close).toHaveBeenCalledTimes(1);
  });

  // Purpose: after a stop ngrok refused, a new start that fails must not
  // close the ingress either: the old listener may still forward into it.
  it('keeps the ingress open when a start fails while an old listener is unclosed', async () => {
    await manager.start({ port: 4242 });
    const disconnect = ngrok.disconnect as unknown as ReturnType<typeof vi.fn>;
    mockListener.close.mockRejectedValueOnce(new Error('ngrok said no'));
    disconnect.mockRejectedValueOnce(new Error('still no'));
    await expect(manager.stopOwnTunnel()).rejects.toThrow('ngrok said no');

    forward.mockRejectedValueOnce(new Error('domain in use'));
    await expect(manager.start({ port: 4242 })).rejects.toThrow('domain in use');
    mockListener.url.mockReturnValueOnce(null);
    await expect(manager.start({ port: 4242 })).rejects.toThrow('no public URL');
    expect(ingress.close).not.toHaveBeenCalled();
  });

  // Purpose: a stop that lands while ngrok is still opening wins, and the
  // ingress the open started is closed rather than left listening.
  it('closes the ingress when a stop overtakes a pending open', async () => {
    let finishForward!: (listener: typeof mockListener) => void;
    forward.mockImplementationOnce(
      () => new Promise<typeof mockListener>((resolve) => (finishForward = resolve))
    );
    const starting = manager.start({ port: 4242 });
    await vi.waitFor(() => expect(forward).toHaveBeenCalled());
    await manager.stopOwnTunnel();
    finishForward(mockListener);

    await expect(starting).rejects.toThrow('closed while it was opening');
    expect(mockListener.close).toHaveBeenCalled();
    expect(ingress.close).toHaveBeenCalledTimes(2);
    expect(manager.isRunning).toBe(false);
  });

  // Purpose: a failed open must not leave the ingress listening.
  it('closes the ingress when ngrok fails to open, or opens with no URL', async () => {
    forward.mockRejectedValueOnce(new Error('bad token'));
    await expect(manager.start({ port: 4242 })).rejects.toThrow('bad token');
    expect(ingress.close).toHaveBeenCalledTimes(1);

    mockListener.url.mockReturnValue(null);
    await expect(manager.start({ port: 4242 })).rejects.toThrow('no public URL');
    expect(ingress.close).toHaveBeenCalledTimes(2);
  });
});
