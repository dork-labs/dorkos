import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOriginalDesktopQualification } from '../admission/desktop-qualification.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function originalParent(enabled = true) {
  const ready: unknown[] = [];
  const parent = Object.assign(new EventEmitter(), {
    postMessage(value: unknown) {
      ready.push(value);
    },
  });
  const original = process;
  vi.stubGlobal(
    'process',
    new Proxy(original, {
      get(target, key, receiver) {
        if (key === 'env')
          return {
            ...target.env,
            DORKOS_BROWSER_DESKTOP_QUALIFICATION_CHANNEL: enabled ? '1' : undefined,
          };
        if (key === 'parentPort') return parent;
        return Reflect.get(target, key, receiver);
      },
    })
  );
  return { parent, ready };
}
describe('original desktop server receiver', () => {
  it('ordinary startup registers no qualification receiver or ready message', () => {
    const { parent, ready } = originalParent(false);
    expect(readOriginalDesktopQualification()).toBeUndefined();
    expect(parent.listenerCount('message')).toBe(0);
    expect(ready).toEqual([]);
  });
  it('announces readiness only after its original receiver is registered and refuses late work after expiration', async () => {
    vi.useFakeTimers();
    const { parent, ready } = originalParent();
    const issuer = readOriginalDesktopQualification();
    expect(parent.listenerCount('message')).toBe(1);
    expect(ready).toEqual([{ type: 'browser-desktop-qualification-receiver-ready' }]);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(issuer!()).rejects.toThrow('DESKTOP_QUALIFICATION_CHANNEL_EXPIRED');
    let reads = 0;
    parent.emit('message', {
      get data() {
        reads++;
        throw false;
      },
    });
    expect(reads).toBe(0);
  });
  for (const cause of [false, undefined])
    it(`joins rejected initialization local close without replacing ${String(cause)}`, async () => {
      const { parent } = originalParent();
      const issuer = readOriginalDesktopQualification();
      let closed = 0;
      const port = Object.assign(new EventEmitter(), {
        start() {},
        close() {
          closed++;
          throw new Error('secondary local close');
        },
      });
      parent.emit('message', {
        data: {
          type: 'browser-desktop-qualification-channel',
          nonce: 'a'.repeat(48),
          get grant() {
            throw cause;
          },
        },
        ports: [port],
      });
      await expect(issuer!()).rejects.toBe(cause);
      expect(closed).toBe(1);
    });
});
