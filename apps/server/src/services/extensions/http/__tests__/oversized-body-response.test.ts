import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Context } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { rejectOversizedBody } from '../oversized-body-response.js';

/** Node transport primitives; the production response and drain owners run unchanged. */
function pair() {
  const incoming = Object.assign(new PassThrough(), {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  const outgoing = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn((): void => {
      outgoing.writableEnded = outgoing.writableFinished = true;
      outgoing.emit('finish');
      outgoing.emit('close');
    }),
    destroy: () => {
      outgoing.destroyed = true;
      outgoing.emit('close');
    },
  });
  const context = { env: { incoming, outgoing }, var: {} } as unknown as Context<ApiEnv>;
  return { incoming, outgoing, context };
}

function expectDisposed(p: ReturnType<typeof pair>) {
  for (const event of ['data', 'readable', 'end', 'error', 'aborted', 'close']) {
    expect(p.incoming.listenerCount(event), event).toBe(0);
  }
  expect(p.outgoing.listenerCount('close')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(() => vi.useRealTimers());

it('flushes exact JSON immediately and uses one 500ms deadline despite progress', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  expect(p.outgoing.writeHead).toHaveBeenCalledWith(413, {
    'content-type': 'application/json',
    'content-length': 38,
    connection: 'close',
  });
  expect(p.outgoing.write).toHaveBeenCalledWith('{"error":"That request is too large."}');
  expect(p.outgoing.flushHeaders).toHaveBeenCalledOnce();
  expect(p.outgoing.end).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(499);
  p.incoming.write('progress');
  await vi.advanceTimersByTimeAsync(1);
  expect(p.outgoing.end).toHaveBeenCalledOnce();
  await pending;
  expectDisposed(p);
});

it('discards at most 64MiB after refusal, without waiting for end or deadline', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 63; i++) p.incoming.write(chunk);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.outgoing.end).not.toHaveBeenCalled();
  p.incoming.write(chunk);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.outgoing.end).toHaveBeenCalledOnce();
  await pending;
  expectDisposed(p);
});

it('leaves bytes beyond the 64MiB disposal cap unread, even in one large chunk', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  p.incoming.write(Buffer.alloc(64 * 1024 * 1024 + 1));
  await vi.advanceTimersByTimeAsync(0);
  expect(p.outgoing.end).toHaveBeenCalledOnce();
  expect(p.incoming.readableLength).toBe(1);
  await pending;
  expectDisposed(p);
});

it('finishes on actual input end and removes its timer and every own listener', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  p.incoming.end('remaining input');
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(p.outgoing.end).toHaveBeenCalledOnce();
  expectDisposed(p);
});

it('settles a separate empty EOF after earlier bytes have already drained', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const p = pair();
  let inputEnds = 0;
  const onEnd = () => {
    inputEnds++;
  };
  p.incoming.once('end', onEnd);
  const pending = rejectOversizedBody(p.context);
  try {
    p.incoming.write('earlier input');
    await nextTurn();
    expect(p.incoming.readableLength).toBe(0);
    expect(p.outgoing.end).not.toHaveBeenCalled();
    p.incoming.end();
    for (let turn = 0; turn < 3; turn++) await nextTurn();
    expect(inputEnds).toBe(1);
    expect(p.outgoing.end).toHaveBeenCalledOnce();
    await pending;
    expectDisposed(p);
  } finally {
    p.incoming.off('end', onEnd);
    p.outgoing.destroy();
    await pending;
  }
});

it('releases an errored input without leaking its deadline', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  p.incoming.destroy(new Error('upload failed'));
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  expect(p.outgoing.end).toHaveBeenCalledOnce();
  expectDisposed(p);
});

it('disposes on peer/shutdown response close without ending a destroyed response', async () => {
  vi.useFakeTimers();
  const p = pair();
  const pending = rejectOversizedBody(p.context);
  p.outgoing.destroy();
  await pending;
  expect(p.outgoing.end).not.toHaveBeenCalled();
  expectDisposed(p);
});

it('does not acquire readers, writers or timers for an already closed response', async () => {
  vi.useFakeTimers();
  const p = pair();
  p.outgoing.destroy();
  await rejectOversizedBody(p.context);
  expect(p.outgoing.writeHead).not.toHaveBeenCalled();
  expectDisposed(p);
});

it('disposes input ownership even if the response write throws', async () => {
  vi.useFakeTimers();
  const p = pair();
  p.outgoing.write.mockImplementation(() => {
    throw new Error('write failed');
  });
  await expect(rejectOversizedBody(p.context)).rejects.toThrow('write failed');
  expectDisposed(p);
});
