import { describe, it, expect, vi } from 'vitest';
import { DocFrameQueue } from '../doc-queue';
import { fixture, clock, flush, envelope, receipt, birth, id } from './fixtures';
describe('original-ID bounded queue', () => {
  it('caps pending envelopes at100, includes metadata, cancels unsent and keeps sent uncertainty', async () => {
    let complete!: (value: never) => void;
    const f = fixture({
        submit: vi.fn(
          () =>
            new Promise<never>((resolve) => {
              complete = resolve;
            })
        ),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler);
    const promises = Array.from({ length: 100 }, (_, i) => q.emit(envelope(i + 1)));
    expect(await q.emit(envelope(101))).toEqual({ kind: 'refused' });
    expect(q.getStatus().pending).toBe(100);
    expect(q.getStatus().bytes).toBeGreaterThan(JSON.stringify(envelope()).length * 100);
    f.controller.retire();
    expect(await promises[0]).toEqual({ kind: 'unconfirmed' });
    expect(await promises[99]).toEqual({ kind: 'cancelled' });
    expect(c.timers.size).toBe(0);
    complete({ kind: 'accepted' as const, receipt: receipt() } as never);
    await flush();
    expect(f.ports.submit).toHaveBeenCalledOnce();
  });
  it('refuses byte overflow before100 with serialized metadata accounted', async () => {
    const f = fixture({ submit: () => new Promise(() => {}) }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler);
    const promises = [];
    let refused = 0;
    for (let i = 1; i <= 100; i++) {
      const promise = q.emit(envelope(i, { text: 'x'.repeat(15_500) }));
      promises.push(promise);
      if (q.getStatus().pending < i) {
        expect(await promise).toEqual({ kind: 'refused' });
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(q.getStatus().pending).toBeLessThan(68);
    expect(q.getStatus().bytes).toBeLessThanOrEqual(1_048_576);
    q.retire();
    await Promise.all(promises);
  });
  it('429 inspects original receipt before same bytes resend with bounded jitter', async () => {
    let count = 0;
    const calls: string[] = [],
      f = fixture({
        submit: vi.fn(async (request, condition) => {
          calls.push(`submit:${request.id}:${condition.expectedGeneration}:${request.bytes}`);
          return ++count === 1
            ? { kind: 'retry' as const, retryAfterMs: 100 }
            : { kind: 'accepted' as const, receipt: receipt() };
        }),
        inspect: vi.fn(async (original, condition) => {
          calls.push(`inspect:${original}:${condition.expectedGeneration}`);
          return { kind: 'absent' as const };
        }),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler);
    const payload = { x: 1 },
      promise = q.emit(envelope(1, payload));
    payload.x = 2;
    await flush();
    expect([...c.timers.values()].map((t) => t.delay)).toContain(225);
    c.fire(225);
    expect(await promise).toEqual({ kind: 'accepted' as const, receipt: receipt() });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(calls[2]);
    expect(calls[1]).toBe(`inspect:${id()}:${birth.generation}`);
    expect(calls[0]).toContain('"x":1');
    q.retire();
  });
  it('inspection of accepted receipt settles once without another POST or newID', async () => {
    const f = fixture({
        submit: vi.fn(async () => ({ kind: 'uncertain' as const })),
        inspect: vi.fn(async () => ({ kind: 'accepted' as const, receipt: receipt() })),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      promise = q.emit(envelope());
    await flush();
    c.fire(625);
    expect(await promise).toEqual({ kind: 'accepted' as const, receipt: receipt() });
    expect(q.emit(envelope())).toBe(promise);
    expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.inspect).toHaveBeenCalledOnce();
    q.retire();
  });
  it('unknown retention is unconfirmed and cannot locally resubmit sameID', async () => {
    const f = fixture({
        submit: vi.fn(async () => ({ kind: 'uncertain' as const })),
        inspect: vi.fn(async () => ({ kind: 'unknown' as const })),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      promise = q.emit(envelope());
    await flush();
    c.fire(625);
    expect(await promise).toEqual({ kind: 'unconfirmed' });
    expect(q.emit(envelope())).toBe(promise);
    expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(q.getStatus().unconfirmed).toBe(1);
    q.retire();
  });
  it('refuses changed bytes under duplicateID and a receipt for a differentID', async () => {
    const f = fixture({ submit: async () => ({ kind: 'accepted' as const, receipt: receipt(2) }) }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      promise = q.emit(envelope());
    expect(await q.emit(envelope(1, { x: 2 }))).toEqual({ kind: 'refused' });
    expect(await promise).toEqual({ kind: 'unconfirmed' });
    q.retire();
  });
  it('terminal refusal closes queue, timeout inspection remains truthful', async () => {
    const f = fixture({ submit: async () => ({ kind: 'terminal' as const }) }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler);
    expect(await q.emit(envelope())).toEqual({ kind: 'unconfirmed' });
    expect(q.getStatus().retired).toBe(true);
    expect(c.timers.size).toBe(0);
    const second = fixture({
        submit: () => new Promise(() => {}),
        inspect: async () => ({ kind: 'unknown' as const }),
      }),
      d = clock(),
      r = new DocFrameQueue(second.bound, d.scheduler),
      promise = r.emit(envelope());
    d.fire(15000);
    await flush();
    d.fire(625);
    expect(await promise).toEqual({ kind: 'unconfirmed' });
    r.retire();
  });
  it('fresh handshake/queue after replacement never inherits an old pending promise', async () => {
    const f = fixture({ submit: () => new Promise(() => {}) }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      old = q.emit(envelope());
    q.retire();
    expect(await old).toEqual({ kind: 'unconfirmed' });
    const newer = fixture(),
      next = new DocFrameQueue(newer.bound, c.scheduler);
    expect(await next.emit(envelope())).toEqual({ kind: 'accepted' as const, receipt: receipt() });
    next.retire();
  });
});
describe('queue authority and exhaustion controls', () => {
  it('checks authority after retry wait before inspecting or posting again', async () => {
    let current = true;
    const f = fixture({
        isCurrentOwner: () => current,
        submit: vi.fn(async () => ({ kind: 'retry' as const, retryAfterMs: 1 })),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      pending = q.emit(envelope());
    await flush();
    current = false;
    c.fire(126);
    expect(await pending).toEqual({ kind: 'unconfirmed' });
    expect(f.ports.submit).toHaveBeenCalledOnce();
    expect(f.ports.inspect).not.toHaveBeenCalled();
    expect(c.timers.size).toBe(0);
  });
  it('bounds attempts and retains originalID across every capacity retry', async () => {
    const f = fixture({
        submit: vi.fn(async () => ({ kind: 'retry' as const, retryAfterMs: 0 })),
        inspect: vi.fn(async () => ({ kind: 'absent' as const })),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      pending = q.emit(envelope());
    for (let n = 0; n < 8; n++) {
      await flush();
      await vi.waitFor(() =>
        expect([...c.timers.values()].some((timer) => timer.delay === 125)).toBe(true)
      );
      c.fire(125);
    }
    expect(await pending).toEqual({ kind: 'unconfirmed' });
    expect(f.ports.submit).toHaveBeenCalledTimes(8);
    expect(f.ports.inspect).toHaveBeenCalledTimes(7);
    expect(
      vi
        .mocked(f.ports.submit)
        .mock.calls.every(
          ([request, condition]) =>
            request.id === id() && condition.expectedGeneration === birth.generation
        )
    ).toBe(true);
    q.retire();
  });
  it('terminal inspection closes and cancels all queued work', async () => {
    const f = fixture({
        submit: async () => ({ kind: 'uncertain' }),
        inspect: async () => ({ kind: 'terminal' }),
      }),
      c = clock(),
      q = new DocFrameQueue(f.bound, c.scheduler),
      sent = q.emit(envelope()),
      unsent = q.emit(envelope(2));
    await flush();
    c.fire(625);
    expect(await sent).toEqual({ kind: 'unconfirmed' });
    expect(await unsent).toEqual({ kind: 'cancelled' });
    expect(q.getStatus().retired).toBe(true);
    expect(c.timers.size).toBe(0);
  });
});

describe('reentrant scheduler retirement', () => {
  it('deadline retirement prevents submit even while the bound transport remains current', async () => {
    const f = fixture(),
      c = clock();
    const scheduler = {
      ...c.scheduler,
      schedule(callback: () => void, delay: number) {
        q.retire();
        return c.scheduler.schedule(callback, delay);
      },
    };
    const q: DocFrameQueue = new DocFrameQueue(f.bound, scheduler);
    expect(await q.emit(envelope())).toEqual({ kind: 'unconfirmed' });
    await flush();
    expect(f.bound.current()).toBe(true);
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(c.timers.size).toBe(0);
  });
  it.each(['random', 'retry-schedule'] as const)(
    'retirement during %s drains late retry handles and settles once',
    async (stage) => {
      const f = fixture({
          submit: vi.fn(async () => ({ kind: 'retry' as const, retryAfterMs: 30_000 })),
        }),
        c = clock();
      const scheduler = {
        ...c.scheduler,
        random() {
          if (stage === 'random') f.controller.retire();
          return 0;
        },
        schedule(callback: () => void, delay: number) {
          if (stage === 'retry-schedule' && delay === 30_000) q.retire();
          return c.scheduler.schedule(callback, delay);
        },
      };
      const q: DocFrameQueue = new DocFrameQueue(f.bound, scheduler);
      const settled = vi.fn(),
        pending = q.emit(envelope()).then((outcome) => {
          settled();
          return outcome;
        });
      expect(await pending).toEqual({ kind: 'unconfirmed' });
      await flush();
      expect(settled).toHaveBeenCalledOnce();
      expect(f.ports.submit).toHaveBeenCalledOnce();
      expect(f.ports.inspect).not.toHaveBeenCalled();
      expect(c.timers.size).toBe(0);
      q.retire();
      expect(c.timers.size).toBe(0);
    }
  );
  it('synchronous deadline expiry drains its late handle before any submit', async () => {
    const f = fixture(),
      c = clock();
    let first = true;
    const scheduler = {
      ...c.scheduler,
      schedule(callback: () => void, delay: number) {
        if (first) {
          first = false;
          callback();
        }
        return c.scheduler.schedule(callback, delay);
      },
    };
    const q = new DocFrameQueue(f.bound, scheduler),
      pending = q.emit(envelope());
    await flush();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect([...c.timers.values()].some((t) => t.delay === 15000)).toBe(false);
    q.retire();
    expect(await pending).toEqual({ kind: 'unconfirmed' });
    expect(c.timers.size).toBe(0);
  });
  it('a synchronously finished retry drains its returned handle despite throwing cancellation', async () => {
    let calls = 0;
    const f = fixture({
        submit: vi.fn(async () =>
          ++calls === 1
            ? { kind: 'retry' as const, retryAfterMs: 0 }
            : { kind: 'accepted' as const, receipt: receipt() }
        ),
      }),
      c = clock();
    const scheduler = {
      ...c.scheduler,
      schedule(callback: () => void, delay: number) {
        if (delay === 125) callback();
        return c.scheduler.schedule(callback, delay);
      },
      cancel(timer: unknown) {
        c.scheduler.cancel(timer);
        throw Error('cleanup failed after release');
      },
    };
    const q = new DocFrameQueue(f.bound, scheduler);
    expect(await q.emit(envelope())).toEqual({ kind: 'accepted', receipt: receipt() });
    expect(f.ports.inspect).toHaveBeenCalledOnce();
    expect(f.ports.submit).toHaveBeenCalledTimes(2);
    expect(c.timers.size).toBe(0);
    q.retire();
  });
});

it('an owner predicate retiring only the queue cannot enqueue work after its cleanup', async () => {
  let armed = false;
  const f = fixture({
      isCurrentOwner: () => {
        if (armed) q.retire();
        return true;
      },
    }),
    c = clock();
  const q: DocFrameQueue = new DocFrameQueue(f.bound, c.scheduler);
  armed = true;
  expect(await q.emit(envelope())).toEqual({ kind: 'cancelled' });
  expect(q.getStatus()).toEqual({ pending: 0, bytes: 0, unconfirmed: 0, retired: true });
  expect(f.ports.submit).not.toHaveBeenCalled();
  expect(c.timers.size).toBe(0);
});
