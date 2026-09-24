import { createServer } from 'node:http';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createSignalHandler, createStop } from './shutdown.js';

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

  it('reports a listener that fails to close, once, and still ends the pool', async () => {
    const server = {
      close: vi.fn((callback?: (error?: Error) => void) => callback?.(new Error('no'))),
    };
    const pool = { end: vi.fn(async () => undefined) };
    const stop = createStop({ server, pool });

    await expect(stop()).rejects.toThrow('no');
    await expect(stop()).rejects.toThrow('no');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('cuts an open event stream after the grace period instead of waiting for it', async () => {
    const graceMs = 300;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': open\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No HTTP address');
    const stream = await fetch(`http://127.0.0.1:${address.port}/events`);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': open\n\n');
    const pool = { end: vi.fn(async () => undefined) };
    const stop = createStop({ server, pool, graceMs });

    const started = Date.now();
    await stop();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(graceMs - 20);
    expect(elapsed).toBeLessThan(graceMs + 1_000);
    expect(server.listening).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
    await expect(reader.read()).rejects.toThrow();
  });
});

describe('createSignalHandler', () => {
  function harness(stop: () => Promise<void>) {
    const exit = vi.fn();
    const setExitCode = vi.fn();
    const log = vi.fn();
    return {
      exit,
      setExitCode,
      log,
      onSignal: createSignalHandler(stop, { exit, setExitCode, log }),
    };
  }

  it('stops once, and a second signal while stopping exits at once with code 1', async () => {
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { exit, setExitCode, onSignal } = harness(stop);

    onSignal();
    expect(exit).not.toHaveBeenCalled();
    onSignal();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stop).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('logs a failed stop with exit code 1, and a later signal exits 1 too', async () => {
    const { exit, setExitCode, log, onSignal } = harness(() =>
      Promise.reject(new TypeError('stuck'))
    );

    onSignal();
    await new Promise((resolve) => setImmediate(resolve));
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('Community server did not stop cleanly', 'TypeError');
    onSignal();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 0 on a signal after a stop that finished', async () => {
    const { exit, onSignal } = harness(async () => undefined);

    onSignal();
    await new Promise((resolve) => setImmediate(resolve));
    onSignal();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
