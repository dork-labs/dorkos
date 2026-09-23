import { createServer } from 'node:http';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createStop } from './shutdown.js';

describe('createStop', () => {
  it('closes a real listener and pool once when stopped twice at the same time', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // No query ever runs, so the pool never connects; ending it twice still throws.
    const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const close = vi.spyOn(server, 'close');
    const end = vi.spyOn(pool, 'end');
    const timer = setInterval(() => undefined, 60_000);
    const stop = createStop({ server, pool, timers: [timer] });

    const first = stop();
    const second = stop();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(stop()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(pool.ended).toBe(true);
  });

  it('cancels the sweeps first and ends the pool only after the listener has closed', async () => {
    const order: string[] = [];
    let finishClose!: () => void;
    const server = {
      close: vi.fn((callback?: (error?: Error) => void) => {
        order.push('close');
        finishClose = () => callback?.();
      }),
    };
    const pool = { end: vi.fn(async () => void order.push('end')) };
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const timer = setInterval(() => undefined, 60_000);
    const stop = createStop({ server, pool, timers: [timer] });

    const stopping = stop();
    expect(clear).toHaveBeenCalledWith(timer);
    expect(order).toEqual(['close']);
    void stop();
    finishClose();
    await stopping;
    clear.mockRestore();

    expect(order).toEqual(['close', 'end']);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('reports a listener that fails to close, once, and leaves the pool alone', async () => {
    const server = {
      close: vi.fn((callback?: (error?: Error) => void) => callback?.(new Error('no'))),
    };
    const pool = { end: vi.fn(async () => undefined) };
    const stop = createStop({ server, pool });

    await expect(stop()).rejects.toThrow('no');
    await expect(stop()).rejects.toThrow('no');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).not.toHaveBeenCalled();
  });
});
