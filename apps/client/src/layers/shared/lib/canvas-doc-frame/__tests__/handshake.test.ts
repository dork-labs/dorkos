import { MessageChannel } from 'node:worker_threads';
import { describe, it, expect, vi } from 'vitest';
import { DocFrameHandshake } from '../doc-handshake';
import { fixture, clock, flush, envelope, receipt } from './fixtures';
function setup(origin = 'null', noncePrefix = 'nonce') {
  const f = fixture({}, origin),
    c = clock(),
    channels: MessageChannel[] = [],
    offline = vi.fn();
  let nonce = 0;
  const h = new DocFrameHandshake(f.bound, {
    nonce: () => `${noncePrefix}${++nonce}`,
    channel: () => {
      const ch = new MessageChannel();
      channels.push(ch);
      return ch as unknown as { port1: MessagePort; port2: MessagePort };
    },
    scheduler: c.scheduler,
    offline,
  });
  h.start();
  const challenge = vi.mocked(f.frame.postMessage).mock.calls[0][0];
  const ack = { ...challenge, kind: 'ack' };
  const event = { source: f.frame, origin, data: ack, ports: [] as MessagePort[] };
  return { ...f, ...c, h, channels, offline, challenge, event };
}
describe('Doc-only strict host handshake', () => {
  it('actual loaded captured opaqueWindow gets challenge and exactly one transferred real port', () => {
    const f = setup();
    expect(f.frame.postMessage).toHaveBeenCalledWith(f.challenge, '*');
    expect(f.h.receive(f.event)).toBe(true);
    expect(f.h.receive(f.event)).toBe(true);
    expect(f.channels).toHaveLength(1);
    expect(f.frame.postMessage).toHaveBeenCalledTimes(2);
    f.h.close();
    f.channels[0].port2.close();
  });
  it.each([
    'source',
    'origin',
    'protocol',
    'nonce',
    'requestToken',
    'loadToken',
    'generation',
    'ports',
  ])('refuses wrong %s without transfer', (field) => {
    const f = setup('https://preview.example');
    const event = { ...f.event, data: { ...f.event.data } };
    if (field === 'source') event.source = {} as Window;
    else if (field === 'origin') event.origin = 'https://evil.example';
    else if (field === 'ports') event.ports = [{} as MessagePort];
    else event.data[field] = field === 'loadToken' ? 999 : 'wrong';
    expect(f.h.receive(event)).toBe(false);
    expect(f.channels).toHaveLength(0);
    f.h.close();
  });
  it('slowload late listener can ACK until bounded host timeout; timedout ACK cannot transfer', () => {
    const f = setup();
    expect(f.channels).toHaveLength(0);
    f.fire(5000);
    expect(f.offline).toHaveBeenCalledOnce();
    expect(f.h.receive(f.event)).toBe(false);
  });
  it('verified pagehide retires shared sibling protocol before any further command', async () => {
    const f = setup();
    let done!: () => void;
    const retired = new Promise<void>((resolve) => {
      done = resolve;
    });
    const sibling = vi.fn(done);
    f.controller.own(f.loaded, sibling);
    f.h.receive(f.event);
    f.channels[0].port2.postMessage({ ...f.challenge, kind: 'retire' });
    await retired;
    expect(sibling).toHaveBeenCalledOnce();
    expect(f.bound.current()).toBe(false);
    expect(f.controller.getCurrent()).toBeNull();
    f.channels[0].port2.close();
  });
  it('real port emits only durable matching receipt and closes on retirement', async () => {
    const f = setup();
    f.h.receive(f.event);
    const received: unknown[] = [];
    f.channels[0].port2.on('message', (value) => received.push(value));
    f.channels[0].port2.postMessage({
      ...f.challenge,
      kind: 'emit',
      requestId: envelope().id,
      event: envelope(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toContainEqual({
      ...f.challenge,
      kind: 'receipt',
      requestId: envelope().id,
      receipt: receipt(),
    });
    f.controller.retire();
    expect(f.timers.size).toBe(0);
    f.channels[0].port2.close();
  });
  it('channel creation and cleanup exceptions cannot preserve admission', () => {
    const f = fixture(),
      c = clock();
    let n = 0;
    const offline = vi.fn(() => {
      throw new Error('observer');
    });
    const h = new DocFrameHandshake(f.bound, {
      nonce: () => `${++n}`,
      channel: () => {
        throw new Error('channel');
      },
      scheduler: c.scheduler,
      offline,
    });
    h.start();
    const challenge = vi.mocked(f.frame.postMessage).mock.calls[0][0];
    expect(
      h.receive({ source: f.frame, origin: 'null', ports: [], data: { ...challenge, kind: 'ack' } })
    ).toBe(false);
    expect(offline).toHaveBeenCalledOnce();
    expect(
      h.receive({ source: f.frame, origin: 'null', ports: [], data: { ...challenge, kind: 'ack' } })
    ).toBe(false);
  });
});
describe('reentrant establishment resources', () => {
  it.each(['cancel', 'factory', 'start'] as const)(
    'retirement during %s refuses transfer and independently drains returned pair',
    (stage) => {
      const f = fixture(),
        c = clock(),
        channels: MessageChannel[] = [];
      const closed = [vi.fn(), vi.fn()];
      let n = 0;
      let cancelOnce = true;
      const scheduler = {
        ...c.scheduler,
        cancel(timer: unknown) {
          c.scheduler.cancel(timer);
          if (stage === 'cancel' && cancelOnce) {
            cancelOnce = false;
            f.controller.retire();
          }
        },
      };
      const h: DocFrameHandshake = new DocFrameHandshake(f.bound, {
        nonce: () => `${++n}`,
        scheduler,
        offline: () => {},
        channel() {
          const native = new MessageChannel();
          channels.push(native);
          if (stage === 'factory') f.controller.retire();
          return {
            port1: {
              postMessage: (value: unknown) => native.port1.postMessage(value),
              onmessage: null,
              start() {
                native.port1.start();
                if (stage === 'start') f.controller.retire();
              },
              close() {
                closed[0]();
                native.port1.close();
                throw new Error('first close');
              },
            } as unknown as MessagePort,
            port2: {
              close() {
                closed[1]();
                native.port2.close();
              },
            } as unknown as MessagePort,
          };
        },
      });
      try {
        h.start();
        const challenge = vi.mocked(f.frame.postMessage).mock.calls[0][0];
        const ack = {
          source: f.frame,
          origin: 'null',
          ports: [],
          data: { ...challenge, kind: 'ack' },
        };
        expect(h.receive(ack)).toBe(false);
        expect(
          vi.mocked(f.frame.postMessage).mock.calls.filter(([value]) => value.kind === 'connect')
            .length
        ).toBe(0);
        expect(f.bound.current()).toBe(false);
        expect(h.receive(ack)).toBe(false);
        if (stage !== 'cancel') {
          expect(closed[0]).toHaveBeenCalled();
          expect(closed[1]).toHaveBeenCalled();
        }
        expect(c.timers.size).toBe(0);
      } finally {
        h.close();
        channels.forEach((ch) => {
          ch.port1.close();
          ch.port2.close();
        });
      }
    }
  );
  it('a reentrant duplicate ACK reserves one native pair without repeating transfer', () => {
    const f = fixture(),
      c = clock(),
      channels: MessageChannel[] = [];
    let ack!: Parameters<DocFrameHandshake['receive']>[0],
      n = 0;
    const h: DocFrameHandshake = new DocFrameHandshake(f.bound, {
      nonce: () => `${++n}`,
      scheduler: c.scheduler,
      offline: () => {},
      channel() {
        expect(h.receive(ack)).toBe(true);
        const ch = new MessageChannel();
        channels.push(ch);
        return ch as unknown as { port1: MessagePort; port2: MessagePort };
      },
    });
    try {
      h.start();
      const challenge = vi.mocked(f.frame.postMessage).mock.calls[0][0];
      ack = { source: f.frame, origin: 'null', ports: [], data: { ...challenge, kind: 'ack' } };
      expect(h.receive(ack)).toBe(true);
      expect(
        vi.mocked(f.frame.postMessage).mock.calls.filter(([value]) => value.kind === 'connect')
          .length
      ).toBe(1);
      expect(channels.length).toBe(1);
    } finally {
      h.close();
      channels.forEach((ch) => {
        ch.port1.close();
        ch.port2.close();
      });
    }
  });
});

describe('provisional initial handshake deadline', () => {
  it.each(['owner', 'close', 'deadline'] as const)(
    '%s retirement during scheduling suppresses challenge and drains the late handle',
    (stage) => {
      const f = fixture(),
        c = clock(),
        offline = vi.fn();
      const scheduler = {
        ...c.scheduler,
        schedule(callback: () => void, delay: number) {
          if (stage === 'owner') f.controller.retire();
          else if (stage === 'close') h.close();
          else callback();
          return c.scheduler.schedule(callback, delay);
        },
        cancel(timer: unknown) {
          c.scheduler.cancel(timer);
          throw Error('cleanup observer');
        },
      };
      const h: DocFrameHandshake = new DocFrameHandshake(f.bound, {
        nonce: () => 'initial',
        channel: () => {
          throw Error('no transfer permitted');
        },
        scheduler,
        offline,
      });
      h.start();
      h.start();
      expect(f.frame.postMessage).not.toHaveBeenCalled();
      expect(c.timers.size).toBe(0);
      expect(offline).toHaveBeenCalledOnce();
      h.close();
    }
  );
});

it('two captured controllers isolate original windows, ports and matching durable responses', async () => {
  const first = setup(),
    second = setup('null', 'second-nonce');
  const firstMessages: unknown[] = [],
    secondMessages: unknown[] = [];
  let failed = false,
    originalCause: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      originalCause = cause;
    }
  };
  try {
    expect(first.controller).not.toBe(second.controller);
    expect(first.frame).not.toBe(second.frame);
    expect(first.h.receive(second.event)).toBe(false);
    expect(second.h.receive(first.event)).toBe(false);
    expect(first.channels).toHaveLength(0);
    expect(second.channels).toHaveLength(0);
    expect(first.h.receive(first.event)).toBe(true);
    expect(second.h.receive(second.event)).toBe(true);
    expect(first.channels).toHaveLength(1);
    expect(second.channels).toHaveLength(1);
    first.channels[0].port2.on('message', (value) => firstMessages.push(value));
    second.channels[0].port2.on('message', (value) => secondMessages.push(value));
    vi.mocked(second.ports.submit).mockResolvedValue({ kind: 'accepted', receipt: receipt(2) });
    // An original request from the other captured load cannot use this controller's port.
    second.channels[0].port2.postMessage({
      ...first.challenge,
      kind: 'emit',
      requestId: envelope().id,
      event: envelope(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await flush();
    expect(second.ports.submit).not.toHaveBeenCalled();
    expect(secondMessages).toEqual([]);
    first.channels[0].port2.postMessage({
      ...first.challenge,
      kind: 'emit',
      requestId: envelope().id,
      event: envelope(),
    });
    second.channels[0].port2.postMessage({
      ...second.challenge,
      kind: 'emit',
      requestId: envelope(2).id,
      event: envelope(2),
    });
    await vi.waitFor(() => {
      expect(first.ports.submit).toHaveBeenCalledOnce();
      expect(second.ports.submit).toHaveBeenCalledOnce();
      expect(firstMessages).toEqual([
        {
          ...first.challenge,
          kind: 'receipt',
          requestId: envelope().id,
          receipt: receipt(),
        },
      ]);
      expect(secondMessages).toEqual([
        {
          ...second.challenge,
          kind: 'receipt',
          requestId: envelope(2).id,
          receipt: receipt(2),
        },
      ]);
    });
    first.controller.retire();
    expect(first.bound.current()).toBe(false);
    expect(second.bound.current()).toBe(true);
    expect(first.timers.size).toBe(0);
  } catch (cause) {
    remember(cause);
  }
  for (const host of [first, second]) {
    try {
      host.h.close();
    } catch (cause) {
      remember(cause);
    }
    for (const channel of host.channels) {
      try {
        channel.port2.close();
      } catch (cause) {
        remember(cause);
      }
    }
  }
  if (failed) throw originalCause;
});
