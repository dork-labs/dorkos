import { createContext, runInContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { DOC_FRAME_SHIM_SCRIPT } from '../doc-frame-shim.js';
const corr = {
  protocol: 'dorkos-doc',
  v: 1,
  nonce: 'nonce',
  requestToken: 'request',
  loadToken: 1,
  generation: 'a'.repeat(64),
};
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function setup(prelude = '') {
  const sent: unknown[] = [],
    listeners = new Map<string, (event: unknown) => void>(),
    timers = new Map<number, () => void>();
  let count = 0;
  const parent = { postMessage: vi.fn((...args: unknown[]) => sent.push(args)) };
  const window = {
    parent,
    addEventListener(type: string, fn: (event: unknown) => void) {
      listeners.set(type, fn);
    },
  };
  const context = createContext({
    window,
    crypto: { randomUUID: () => id() },
    TextEncoder,
    setTimeout(callback: () => void) {
      const n = ++count;
      timers.set(n, callback);
      return n;
    },
    clearTimeout(n: number) {
      timers.delete(n);
    },
  });
  if (prelude) runInContext(prelude, context);
  runInContext(DOC_FRAME_SHIM_SCRIPT, context);
  const copy = (value: unknown) => runInContext(`(${JSON.stringify(value)})`, context);
  const dispatch = (
    data: unknown,
    options: { source?: object; origin?: string; ports?: unknown[] } = {}
  ) =>
    listeners.get('message')?.({
      data: copy(data),
      source: options.source ?? parent,
      origin: options.origin ?? 'https://host.example',
      ports: options.ports ?? [],
    });
  const channel = {
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    onmessage: null as null | ((event: unknown) => void),
  };
  const deliver = (data: unknown) => channel.onmessage?.({ data: copy(data), ports: [] });
  const sdk = (
    Object.getOwnPropertyDescriptor(window, 'dorkos')?.value as
      | {
          channel: {
            emit(type: string, payload: unknown, options?: unknown): Promise<unknown>;
            on(type: string, fn: (value: unknown) => void): () => void;
            state: unknown;
            status: string;
          };
        }
      | undefined
  )?.channel;
  const connect = () => {
    dispatch({ ...corr, kind: 'challenge' });
    dispatch({ ...corr, kind: 'connect' }, { ports: [channel] });
  };
  return {
    context,
    window,
    parent,
    sent,
    listeners,
    timers,
    dispatch,
    channel,
    deliver,
    sdk,
    connect,
    copy,
    fire() {
      const next = timers.entries().next().value;
      if (!next) throw new Error('No timer');
      timers.delete(next[0]);
      next[1]();
    },
  };
}
describe('fixed unactivated Doc shim', () => {
  it('earlyhello is bounded but listener survives exhaustion and host-loaded challenge', () => {
    const f = setup();
    for (let i = 0; i < 5; i++) f.fire();
    expect(f.sent).toHaveLength(6);
    expect(f.sdk?.status).toBe('offline');
    f.connect();
    expect(f.sdk?.status).toBe('ready');
    expect(f.channel.start).toHaveBeenCalledOnce();
    expect(f.parent.postMessage).toHaveBeenLastCalledWith(
      { ...corr, kind: 'ack' },
      'https://host.example'
    );
    expect(f.timers.size).toBe(0);
  });
  it('refuses wrong parent/origin/protocol and unsolicited or duplicate ports', () => {
    const f = setup();
    f.dispatch({ ...corr, kind: 'challenge' }, { source: {} });
    f.dispatch({ ...corr, kind: 'connect' }, { ports: [f.channel] });
    expect(f.channel.start).not.toHaveBeenCalled();
    f.dispatch({ ...corr, kind: 'challenge' });
    f.dispatch(
      { ...corr, kind: 'connect' },
      { origin: 'https://evil.example', ports: [f.channel] }
    );
    f.dispatch({ ...corr, kind: 'connect', protocol: 'devtools' }, { ports: [f.channel] });
    expect(f.channel.start).not.toHaveBeenCalled();
    f.dispatch({ ...corr, kind: 'connect' }, { ports: [f.channel] });
    f.dispatch({ ...corr, kind: 'connect' }, { ports: [f.channel] });
    expect(f.channel.start).toHaveBeenCalledOnce();
  });
  it('emit remains pending until matching durable receipt; duplicate receipts settle once', async () => {
    const f = setup();
    f.connect();
    const promise = f.sdk!.emit('save', f.copy({ text: 'value' }), f.copy({ id: id() }));
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const wire = f.channel.postMessage.mock.calls[0][0];
    expect(wire).toEqual({
      ...corr,
      kind: 'emit',
      requestId: id(),
      event: { v: 1, id: id(), type: 'save', payload: { text: 'value' } },
    });
    f.deliver({
      ...corr,
      kind: 'receipt',
      requestId: id(),
      receipt: { receipt: { id: id(2), status: 'recorded', docSeq: 1 }, deliveries: [] },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const value = { receipt: { id: id(), status: 'recorded', docSeq: 1 }, deliveries: [] };
    f.deliver({ ...corr, kind: 'receipt', requestId: id(), receipt: value });
    expect(await promise).toEqual(value);
    f.deliver({ ...corr, kind: 'receipt', requestId: id(), receipt: value });
    expect(f.channel.postMessage).toHaveBeenCalledOnce();
  });
  it('pending sameID reuses original bytes and refuses changed payload', async () => {
    const f = setup();
    f.connect();
    const promise = f.sdk!.emit('save', f.copy({ x: 1 }), f.copy({ id: id() }));
    expect(f.sdk!.emit('save', f.copy({ x: 1 }), f.copy({ id: id() }))).toBe(promise);
    await expect(f.sdk!.emit('save', f.copy({ x: 2 }), f.copy({ id: id() }))).rejects.toMatchObject(
      { outcome: 'refused' }
    );
    f.listeners.get('pagehide')?.({});
    await expect(promise).rejects.toMatchObject({ outcome: 'unconfirmed' });
    expect(f.timers.size).toBe(0);
    f.dispatch({ ...corr, kind: 'challenge' });
    expect(f.sdk!.status).toBe('offline');
  });
  it('read-only deep state resets to lower same-birth revision and catches observers', () => {
    const f = setup(),
      seen = vi.fn();
    f.connect();
    f.sdk!.on('state', () => {
      throw new Error('observer');
    });
    const unsubscribe = f.sdk!.on('state', seen);
    f.deliver({
      ...corr,
      kind: 'state',
      state: { nested: { text: 'old' } },
      stateRev: 100,
      docSeq: 100,
      reset: true,
    });
    expect(Object.isFrozen(f.sdk!.state)).toBe(true);
    expect(Object.isFrozen((f.sdk!.state as { nested: object }).nested)).toBe(true);
    f.deliver({
      ...corr,
      kind: 'state',
      state: { text: 'new' },
      stateRev: 1,
      docSeq: 1,
      reset: true,
    });
    expect(f.sdk!.state).toEqual({ text: 'new' });
    expect(seen).toHaveBeenCalledTimes(2);
    unsubscribe();
    f.deliver({
      ...corr,
      kind: 'state',
      state: { text: 'later' },
      stateRev: 2,
      docSeq: 2,
      reset: false,
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(() => {
      f.sdk!.state = {};
    }).toThrow();
  });
  it('terminal status closes pending work truthfully and preserves revoked status', async () => {
    const f = setup();
    f.connect();
    const pending = f.sdk!.emit('save', f.copy({}), f.copy({ id: id() }));
    f.deliver({ ...corr, kind: 'status', status: 'revoked', unconfirmed: true });
    await expect(pending).rejects.toMatchObject({ outcome: 'unconfirmed' });
    expect(f.sdk!.status).toBe('revoked');
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it('bounds local100 requests and rejects reserved/schema events before sending', async () => {
    const f = setup();
    f.connect();
    const pending = [];
    for (let i = 1; i <= 100; i++)
      pending.push(f.sdk!.emit('save', f.copy({ x: i }), f.copy({ id: id(i) })));
    await expect(f.sdk!.emit('save', f.copy({}), f.copy({ id: id(101) }))).rejects.toMatchObject({
      outcome: 'refused',
    });
    expect(f.channel.postMessage).toHaveBeenCalledTimes(100);
    await expect(f.sdk!.emit('doc.changed', f.copy({}))).rejects.toMatchObject({
      outcome: 'refused',
    });
    await expect(f.sdk!.emit('save', f.copy({ text: 'x'.repeat(17_000) }))).rejects.toMatchObject({
      outcome: 'refused',
    });
    f.listeners.get('pagehide')?.({});
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'rejected')
    ).toBe(true);
  });
  it('metadata-inclusive byte cap refuses before100 max envelopes', async () => {
    const f = setup();
    f.connect();
    const promises = [];
    let failures = 0;
    for (let n = 1; n <= 100; n++) {
      const p = f.sdk!.emit('save', f.copy({ text: 'x'.repeat(15_500) }), f.copy({ id: id(n) }));
      promises.push(p);
      void p.catch(() => {
        failures++;
      });
    }
    await Promise.resolve();
    expect(failures).toBeGreaterThan(0);
    expect(f.channel.postMessage.mock.calls.length).toBeLessThan(68);
    f.listeners.get('pagehide')?.({});
    await Promise.allSettled(promises);
  });
  it('does not read or replace an early conflicting global/accessor', () => {
    const f = setup(
      "let reads=0;Object.defineProperty(window,'dorkos',{get(){reads++;throw Error('getter');}});"
    );
    expect(runInContext('reads', f.context)).toBe(0);
    expect(f.listeners.size).toBe(0);
    const g = setup('window.dorkos={channel:{existing:true}};');
    expect((g.window as unknown as { dorkos: { channel: unknown } }).dorkos.channel).toEqual({
      existing: true,
    });
    expect(g.listeners.size).toBe(0);
  });
  it('script is fixed regardless of HTML/BOM/headlike strings and has no credentials or API call', () => {
    expect(DOC_FRAME_SHIM_SCRIPT).not.toContain('</script');
    expect(DOC_FRAME_SHIM_SCRIPT).not.toMatch(
      /fetch\(|\/api\/|expectedGeneration|grant|accessToken|documentPath/
    );
    expect(() => new Function(DOC_FRAME_SHIM_SCRIPT)).not.toThrow();
    for (const html of [
      '\uFEFF<head><script>early()</script>',
      '<!--<head>--><script>early()</script>',
      '<header>x</header>',
      '<script>early()</script>',
    ])
      expect(DOC_FRAME_SHIM_SCRIPT).not.toContain(html);
  });
});
it('opaque parent origin uses wildcard only for outbound targeting and remains exact inbound', () => {
  const f = setup();
  f.dispatch({ ...corr, kind: 'challenge' }, { origin: 'null' });
  expect(f.parent.postMessage).toHaveBeenLastCalledWith({ ...corr, kind: 'ack' }, '*');
  f.dispatch({ ...corr, kind: 'connect' }, { origin: 'https://wrong.example', ports: [f.channel] });
  expect(f.channel.start).not.toHaveBeenCalled();
  f.dispatch({ ...corr, kind: 'connect' }, { origin: 'null', ports: [f.channel] });
  expect(f.channel.start).toHaveBeenCalledOnce();
});

describe('terminal page lifetime during public status callbacks', () => {
  it.each([false, true])(
    'pagehide wins over outer challenge even when observer throws=%s',
    (throws) => {
      const f = setup();
      let count = 0;
      f.sdk!.on('status', () => {
        count++;
        f.listeners.get('pagehide')!({});
        if (throws) throw Error('observer');
      });
      f.dispatch({ ...corr, kind: 'challenge' });
      expect(f.sdk!.status).toBe('offline');
      expect(f.sdk!.state).toBeNull();
      expect(f.timers.size).toBe(0);
      expect(count).toBe(2);
      expect(
        f.parent.postMessage.mock.calls.filter(
          ([value]) => (value as { kind: string }).kind === 'ack'
        )
      ).toHaveLength(0);
      f.dispatch({ ...corr, kind: 'connect' }, { ports: [f.channel] });
      expect(f.channel.start).not.toHaveBeenCalled();
      expect(f.sdk!.status).toBe('offline');
    }
  );
  it('a nested genuine host challenge supersedes the outer correlation after status notification', () => {
    const f = setup(),
      next = {
        ...corr,
        nonce: 'new-nonce',
        requestToken: 'new-request',
        generation: 'b'.repeat(64),
      };
    let once = true;
    f.sdk!.on('status', () => {
      if (once) {
        once = false;
        f.dispatch({ ...next, kind: 'challenge' });
      }
    });
    f.dispatch({ ...corr, kind: 'challenge' });
    expect(
      f.parent.postMessage.mock.calls
        .filter(([value]) => (value as { kind: string }).kind === 'ack')
        .map(([value]) => (value as { nonce: string }).nonce)
    ).toEqual(['new-nonce']);
    f.dispatch({ ...next, kind: 'connect' }, { ports: [f.channel] });
    expect(f.sdk!.status).toBe('ready');
    expect(f.channel.start).toHaveBeenCalledOnce();
    f.listeners.get('pagehide')!({});
    expect(f.sdk!.status).toBe('offline');
    expect(f.timers.size).toBe(0);
  });
});
