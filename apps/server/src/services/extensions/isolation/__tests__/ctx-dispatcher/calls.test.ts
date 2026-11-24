import { setup } from './fixtures.js';
import { describe, expect, it } from 'vitest';
import type { RetMessage } from '../../ipc-protocol.js';

describe('CtxDispatcher calls', () => {
  // Purpose: a table call reaches the real method, with the real object as
  // `this` (the secret store is a class), and the value comes back.
  it('runs a table call through the real ctx', async () => {
    const t = setup();
    await t.call('secrets.set', ['k', 'v'], 1);
    const ret = await t.call('secrets.get', ['k'], 2);
    expect(ret).toEqual({ type: 'ret', id: 2, ok: true, value: 'v' });
    expect(t.dispatcher.dispatchCounts()).toMatchObject({ 'secrets.set': 1, 'secrets.get': 1 });
    expect(t.inFlight()).toBe(0);
  });

  // Purpose: nothing outside the table is reachable, including prototype
  // keys, inherited methods, and a real host method the table leaves out.
  it.each([
    'secrets.keys',
    '__proto__',
    'constructor',
    'secrets.constructor',
    'secrets.__proto__',
    'toString',
    'secrets.get.call',
    'inbox.raise.apply',
    'process.exit',
    'storage',
    'extensionId',
  ])('refuses a call to %j and reaches nothing', async (p) => {
    const t = setup();
    const ret = await t.call(p, []);
    expect(ret.ok).toBe(false);
    expect(ret.error?.code).toBe('ERR_EXTENSION_CTX_UNKNOWN');
    // The child's path is never echoed back.
    expect(ret.error?.message).toBe("That isn't something an isolated extension's ctx can do.");
    expect(t.keysSpy).not.toHaveBeenCalled();
    expect(t.dispatcher.dispatchCounts()).toEqual({});
  });

  // Purpose: a message's kind must match the table: a `call` cannot register
  // a listener, a `sub` cannot invoke a method, an `expose` cannot call.
  it('refuses a kind that does not match the table', async () => {
    const t = setup();
    expect((await t.call('accounts.onUsage', [], 1)).ok).toBe(false);
    expect((await t.call('accounts.registerAdvisor', [], 2)).ok).toBe(false);
    t.handle({ type: 'sub', id: 3, path: 'secrets.get' });
    t.handle({ type: 'expose', id: 4, path: 'storage.saveData', methods: ['rank'] });
    const refused = t.sent
      .filter((m) => m.type === 'ret' && !m.ok)
      .map((m) => (m as RetMessage).id);
    expect(refused).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(t.raw.accounts.onUsage).not.toHaveBeenCalled();
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
    expect(t.raw.accounts.registerAdvisor).not.toHaveBeenCalled();
  });

  // Purpose: arguments must be a short array of plain data. Each shape below
  // can arrive over the advanced-serialization channel (or is built to show
  // the rule), and none reaches the real method.
  it.each([
    ['a non-array', { 0: 'k' }],
    ['a string', 'k'],
    ['too many', Array.from({ length: 9 }, () => 'x')],
    ['a __proto__ key', [JSON.parse('{"__proto__": {"polluted": true}}')]],
    ['a nested __proto__ key', [{ a: [JSON.parse('{"__proto__": 1}')] }]],
    ['a Map', [new Map([['a', 1]])]],
    ['a Set', [new Set([1])]],
    ['a class instance', [new (class Evil {})()]],
    ['an Error', [new Error('x')]],
    ['a RegExp', [/x/]],
    ['a function', [() => 1]],
    ['a symbol', [Symbol('x')]],
    ['an accessor', [Object.defineProperty({}, 'x', { get: () => 1, enumerable: true })]],
    [
      'a cycle',
      (() => {
        const a: Record<string, unknown> = {};
        a.self = a;
        return [a];
      })(),
    ],
    [
      'deep nesting',
      (() => {
        let v: unknown = 'x';
        for (let i = 0; i < 40; i++) v = [v];
        return [v];
      })(),
    ],
  ])('refuses %s as arguments', async (_label, args) => {
    const t = setup();
    const ret = await t.call('storage.saveData', args);
    expect(ret.ok).toBe(false);
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // Purpose: shapes that are tiny on the channel but huge once the host uses
  // them (review blocker): a sparse array with a 90-million length, and one
  // 1.5 MB string shared by 16,000 references (3 MB on the wire, 48 GB of
  // JSON). Each is refused fast, before the real method (whose
  // JSON.stringify would block the host for seconds) is reached.
  it.each([
    [
      'a sparse array',
      () => {
        const a: unknown[] = [];
        a.length = 9e7;
        return [a];
      },
    ],
    [
      'an array with one hole',
      () => {
        const a: unknown[] = [1, 2, 3];
        delete a[1];
        return [a];
      },
    ],
    ['a shared-reference DAG', () => [new Array(16_000).fill({ t: 'x'.repeat(1.5e6) })]],
    ['a long dense array', () => [new Array(60_000).fill(0)]],
  ])('refuses %s quickly and reaches nothing', async (_label, build) => {
    const t = setup();
    const args = build();
    const began = performance.now();
    const ret = await t.call('storage.saveData', args);
    expect(performance.now() - began).toBeLessThan(500);
    expect(ret.ok).toBe(false);
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
  });

  // Purpose: no ctx member takes binary data, and storage.saveData's
  // JSON.stringify writes each byte on its own line (a 4 MB Uint8Array is an
  // 80-million-character string), so the child may send none: not a
  // Uint8Array, another typed array, a DataView or an ArrayBuffer.
  it.each([
    ['a 1.9 MB Uint8Array', () => new Uint8Array(1.9e6)],
    ['a typed-array view', () => new Uint16Array(new ArrayBuffer(1024), 8, 4)],
    ['a DataView', () => new DataView(new ArrayBuffer(16))],
    ['an ArrayBuffer', () => new ArrayBuffer(16)],
  ])('refuses %s from the child quickly and reaches nothing', async (_label, build) => {
    const t = setup();
    const began = performance.now();
    const ret = await t.call('storage.saveData', [{ blob: build() }]);
    expect(performance.now() - began).toBeLessThan(500);
    expect(ret.ok).toBe(false);
    expect(ret.error?.message).toContain('binary');
    expect(t.raw.storage.saveData).not.toHaveBeenCalled();
    // Nor as an emitted payload or a reverse-call answer.
    t.handle({ type: 'emit', event: 'bytes', data: build() });
    expect(t.raw.emit).not.toHaveBeenCalled();
    t.handle({ type: 'expose', id: 50, path: 'inbox.onAction' });
    const pending = t.onAction()!({ key: 'k' }) as Promise<unknown>;
    const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
    t.handle({ type: 'rret', id: rcall.id, ok: true, value: { bytes: build() } });
    await expect(pending).rejects.toThrow("can't use");
  });

  // Purpose: the expanded budget also guards what the child answers to a
  // reverse call, and event payloads forwarded to it.
  it('applies the expanded budget to answers and events', async () => {
    const t = setup();
    t.handle({ type: 'expose', id: 1, path: 'inbox.onAction' });
    const pending = t.onAction()!({ key: 'a' }) as Promise<unknown>;
    const rcall = t.sent.find((m) => m.type === 'rcall') as { id: number };
    const shared = { t: 'x'.repeat(1.5e6) };
    t.handle({ type: 'rret', id: rcall.id, ok: true, value: new Array(16_000).fill(shared) });
    await expect(pending).rejects.toThrow("can't use");
    t.handle({ type: 'sub', id: 2, path: 'accounts.onUsage' });
    t.fire('accounts.onUsage', new Array(16_000).fill(shared));
    expect(t.sent.filter((m) => m.type === 'evt')).toEqual([]);
  });

  // Purpose: the 256-call limit (shared with the program broker) refuses
  // rather than queues, and reaches nothing.
  it('refuses a call when no slot is free', async () => {
    const t = setup({ slots: 0 });
    const ret = await t.call('storage.loadData', []);
    expect(ret.error).toMatchObject({ code: 'ERR_EXTENSION_TOO_MANY_CALLS' });
    expect(t.raw.storage.loadData).not.toHaveBeenCalled();
  });

  // Purpose: an answer that is not plain data never reaches the child.
  it('refuses to send an answer that is not plain data', async () => {
    const t = setup();
    t.raw.storage.loadData.mockResolvedValueOnce(new Map() as never);
    const ret = await t.call('storage.loadData', []);
    expect(ret.ok).toBe(false);
  });
});
